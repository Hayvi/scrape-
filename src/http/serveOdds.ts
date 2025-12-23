import type { Env } from "../env"
import { getClient } from "../db"
import { json, notFound } from "./response"

export async function serveOdds(env: Env, url: URL, sportKey: string, live: boolean) {
  const db = getClient(env)
  const source = "tounesbet"
  const s = await db.from("sports").select("id,key,name").eq("source", source).eq("key", sportKey).maybeSingle()
  if (!s.data) return notFound("sport")
  const sportId = s.data.id
  const leagues = await db.from("leagues").select("id,name").eq("source", source).eq("sport_id", sportId)
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

  const nowIso = new Date().toISOString()
  const buildGamesQ = () => {
    let q = db.from("games")
      .select("id,external_id,league_id,home_team,away_team,start_time,live,last_seen_at")
      .eq("source", source)
      .in("league_id", leagueIds)
      .eq("live", live)
    if (!live && !includeStartedFlag) {
      q = q.gt("start_time", nowIso)
    }
    if (!live && !includeStale && seenWithinMinutes > 0) {
      q = q.gte("last_seen_at", seenCutoffIso)
    }
    return q
  }

  const gamesData: { id: number; external_id: string; league_id: number; home_team: string; away_team: string; start_time: string; live: boolean; last_seen_at?: string }[] = []
  const pageSize = 5000
  let offset = 0
  for (;;) {
    const res = await buildGamesQ()
      .order("id", { ascending: true })
      .range(offset, offset + pageSize - 1)
    if (res.error) throw new Error(`games select failed: ${JSON.stringify(res.error)}`)
    const rows = (res.data ?? []) as any[]
    gamesData.push(...rows)
    if (rows.length < pageSize) break
    offset += pageSize
  }
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

  const marketsData: { id: any; game_id: any; key: string; name: string; external_id: string; outcomes?: any[] }[] = []
  const desiredMarketExts = gamesData.map(g => `${g.external_id}_1x2`).filter(Boolean)
  if (desiredMarketExts.length) {
    const chunkSize = 250
    for (let i = 0; i < desiredMarketExts.length; i += chunkSize) {
      const chunk = desiredMarketExts.slice(i, i + chunkSize)
      const res = await db
        .from("markets")
        .select("id,game_id,key,name,external_id,outcomes(id,label,price,handicap)")
        .eq("source", source)
        .in("external_id", chunk)
        .range(0, 9999)
      if (res.error) throw new Error(`markets select failed: ${JSON.stringify(res.error)}`)
      marketsData.push(...((res.data ?? []) as any[]))
    }
  }

  const marketsByGame = new Map<string, { id: any; external_id: string; key: string; name: string; outcomes: { id: any; label: string; price: number; handicap: number | null }[] }[]>()
  for (const m of marketsData) {
    marketsByGame.set(String((m as any).game_id), [])
  }
  for (const m of marketsData) {
    const arr = marketsByGame.get(String((m as any).game_id))!
    const outs = Array.isArray((m as any).outcomes) ? (m as any).outcomes : []
    arr.push({
      id: (m as any).id,
      external_id: String((m as any).external_id ?? ""),
      key: String((m as any).key ?? ""),
      name: String((m as any).name ?? ""),
      outcomes: outs.map((o: any) => ({ id: o.id, label: o.label, price: o.price, handicap: o.handicap }))
    })
  }

  function pickMain1x2(markets: { id: any; external_id: string; key: string; name: string; outcomes: { id: any; label: string; price: number; handicap: number | null }[] }[]) {
    const candidates = (markets ?? []).filter(m => String(m?.key ?? "").toLowerCase() === "1x2")
    if (!candidates.length) return []

    const norm = (s: any) => String(s ?? "").trim().toUpperCase()
    const pickOutcomes = (m: any) => {
      const outs = Array.isArray(m?.outcomes) ? m.outcomes : []
      const wanted = outs.filter((o: any) => {
        const l = norm(o?.label)
        return (l === "1" || l === "X" || l === "2") && (o?.handicap == null)
      })
      const seen = new Set<string>()
      const cleaned: any[] = []
      for (const o of wanted) {
        const l = norm(o?.label)
        if (seen.has(l)) continue
        seen.add(l)
        cleaned.push(o)
        if (seen.size >= 3) break
      }
      return cleaned
    }

    const isCanonical3Way = (m: any) => {
      const outs = pickOutcomes(m)
      const labels = new Set(outs.map((o: any) => norm(o?.label)))
      return outs.length === 3 && labels.size === 3 && labels.has("1") && labels.has("X") && labels.has("2")
    }

    const canonical = candidates.find(m => String(m.external_id ?? "").endsWith("_1x2") && isCanonical3Way(m))
      ?? candidates.find(m => norm(m.name) === "1X2" && isCanonical3Way(m))
      ?? candidates.find(isCanonical3Way)
      ?? candidates[0]

    if (!canonical) return []
    return [{ ...canonical, outcomes: pickOutcomes(canonical) }]
  }

  const gamesByLeague = new Map<number, any[]>()
  for (const l of leaguesData) gamesByLeague.set(l.id, [])
  for (const g of gamesData) {
    const meta = live ? (liveMetaByLsId.get(g.external_id) ?? null) : null
    const ms = marketsByGame.get(String((g as any).id)) ?? []
    gamesByLeague.get(g.league_id)!.push({ id: g.id, externalId: g.external_id, homeTeam: g.home_team, awayTeam: g.away_team, startTime: g.start_time, live: g.live, markets: pickMain1x2(ms), liveMeta: meta })
  }

  const resp = {
    sport: { key: s.data.key, name: s.data.name },
    leagues: leaguesData.map((l) => ({ id: l.id, name: l.name, games: gamesByLeague.get(l.id) ?? [] }))
  }
  return json(resp)
}
