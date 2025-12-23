import type { Env } from "../env"
import { getClient } from "../db"
import { json, notFound } from "./response"

export async function serveOdds(env: Env, url: URL, sportKey: string, live: boolean) {
  const db = getClient(env)
  const source = "tounesbet"
  const s = await db.from("sports").select("id,key,name").eq("source", source).eq("key", sportKey).maybeSingle()
  if (!s.data) return notFound("sport")
  const sportId = s.data.id
  const leagues = await db.from("leagues").select("id,name").eq("sport_id", sportId)
  const leaguesData = (leagues.data ?? []) as { id: number; name: string }[]
  const leagueIds = leaguesData.map((l) => l.id)
  if (!leagueIds.length) return json({ sport: { key: s.data.key, name: s.data.name }, leagues: [] })
  const includeStartedFlag = url.searchParams.get("includeStarted") === "1"
  const includeStale = url.searchParams.get("includeStale") === "1"
  const seenRaw = url.searchParams.get("seenWithinMinutes")
  let seenWithinMinutes = Number(seenRaw ?? "180")
  if (!Number.isFinite(seenWithinMinutes)) seenWithinMinutes = 180
  seenWithinMinutes = Math.max(0, Math.min(7 * 24 * 60, seenWithinMinutes))
  const seenCutoffIso = new Date(Date.now() - seenWithinMinutes * 60 * 1000).toISOString()
  let gamesQ = db.from("games")
    .select("id,external_id,league_id,home_team,away_team,start_time,live,last_seen_at")
    .in("league_id", leagueIds)
    .eq("live", live)
  if (!live && !includeStartedFlag) {
    gamesQ = gamesQ.gt("start_time", new Date().toISOString())
  }
  if (!live && !includeStale && seenWithinMinutes > 0) {
    gamesQ = gamesQ.gte("last_seen_at", seenCutoffIso)
  }
  const games = await gamesQ
  const gamesData = (games.data ?? []) as { id: number; external_id: string; league_id: number; home_team: string; away_team: string; start_time: string; live: boolean; last_seen_at?: string }[]
  const gameIds = gamesData.map((g) => g.id)

  const liveMetaByLsId = new Map<string, any>()
  if (live) {
    const lsIds = gamesData.map(g => g.external_id).filter(Boolean)
    if (lsIds.length) {
      const metaRes = await db
        .from("live_meta")
        .select("provider_ls_id,provider_event_id,status_name,clock_time,start_time,home_team,away_team,home_score,away_score,competition_name")
        .eq("provider", "statscore")
        .in("provider_ls_id", lsIds)
      for (const m of metaRes.data ?? []) {
        if (m.provider_ls_id) liveMetaByLsId.set(m.provider_ls_id, m)
      }
    }
  }

  const markets = gameIds.length ? await db.from("markets").select("id,game_id,key,name").in("game_id", gameIds) : { data: [] as any[] }
  const marketsData = (markets.data ?? []) as { id: number; game_id: number; key: string; name: string }[]
  const marketIds = marketsData.map((m) => m.id)
  const outcomes = marketIds.length ? await db.from("outcomes").select("id,market_id,label,price,handicap").in("market_id", marketIds) : { data: [] as any[] }
  const outcomesData = (outcomes.data ?? []) as { id: number; market_id: number; label: string; price: number; handicap: number | null }[]

  const marketsByGame = new Map<number, { id: number; key: string; name: string; outcomes: { id: number; label: string; price: number; handicap: number | null }[] }[]>()
  for (const m of marketsData) {
    marketsByGame.set(m.game_id, [])
  }
  for (const m of marketsData) {
    const arr = marketsByGame.get(m.game_id)!
    arr.push({ id: m.id, key: m.key, name: m.name, outcomes: [] })
  }
  const marketArr = marketsData
  const marketIndex = new Map<number, number>()
  for (let i = 0; i < marketArr.length; i++) marketIndex.set(marketArr[i].id, i)

  for (const o of outcomesData) {
    const idx = marketIndex.get(o.market_id)
    if (idx !== undefined) {
      const m = marketArr[idx]
      const bucket = marketsByGame.get(m.game_id)!
      const entry = bucket.find(x => x.id === m.id)
      if (entry) entry.outcomes.push({ id: o.id, label: o.label, price: o.price, handicap: o.handicap })
    }
  }

  const gamesByLeague = new Map<number, any[]>()
  for (const l of leaguesData) gamesByLeague.set(l.id, [])
  for (const g of gamesData) {
    const meta = live ? (liveMetaByLsId.get(g.external_id) ?? null) : null
    gamesByLeague.get(g.league_id)!.push({ id: g.id, externalId: g.external_id, homeTeam: g.home_team, awayTeam: g.away_team, startTime: g.start_time, live: g.live, markets: marketsByGame.get(g.id) ?? [], liveMeta: meta })
  }

  const resp = {
    sport: { key: s.data.key, name: s.data.name },
    leagues: leaguesData.map((l) => ({ id: l.id, name: l.name, games: gamesByLeague.get(l.id) ?? [] }))
  }
  return json(resp)
}
