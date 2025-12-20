import { persistParsed, runLive, runPrematch } from "./service"
import { getLiveHTML, getMatchOddsGroupedHTML } from "./fetcher"
import { parseLive, parseMatchOddsGrouped } from "./parser"
import { getClient, upsertLiveMeta } from "./db"
import { getStatscoreSSR, parseStatscoreSSR } from "./statscore"
import type { ExecutionContext, ScheduledEvent } from "@cloudflare/workers-types"

export interface Env {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
  DEFAULT_SPORT_ID?: string
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } })
}

function notFound(msg = "Not Found") { return json({ error: msg }, 404) }

async function serveOdds(env: Env, sportKey: string, live: boolean) {
  const db = getClient(env)
  const source = "tounesbet"
  const s = await db.from("sports").select("id,key,name").eq("source", source).eq("key", sportKey).maybeSingle()
  if (!s.data) return notFound("sport")
  const sportId = s.data.id
  const leagues = await db.from("leagues").select("id,name").eq("sport_id", sportId)
  const leaguesData = (leagues.data ?? []) as { id: number; name: string }[]
  const leagueIds = leaguesData.map((l) => l.id)
  if (!leagueIds.length) return json({ sport: { key: s.data.key, name: s.data.name }, leagues: [] })
  const games = await db.from("games").select("id,external_id,league_id,home_team,away_team,start_time,live").in("league_id", leagueIds).eq("live", live)
  const gamesData = (games.data ?? []) as { id: number; external_id: string; league_id: number; home_team: string; away_team: string; start_time: string; live: boolean }[]
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const p = url.pathname
    if (request.method === "GET") {
      if (p === "/api/test/live") {
        const persist = url.searchParams.get("persist") === "1"
        try {
          const html = await getLiveHTML()
          const parsed = parseLive(html)
          let persisted = false
          let persistResult: any = null
          if (persist) {
            persistResult = await persistParsed(env as any, parsed)
            persisted = true
          }
          const leagueCount = parsed.reduce((acc, s) => acc + s.leagues.length, 0)
          const gameCount = parsed.reduce((acc, s) => acc + s.leagues.reduce((a, l) => a + l.games.length, 0), 0)
          const marketCount = parsed.reduce((acc, s) => acc + s.leagues.reduce((a, l) => a + l.games.reduce((b, g) => b + g.markets.length, 0), 0), 0)
          const outcomeCount = parsed.reduce((acc, s) => acc + s.leagues.reduce((a, l) => a + l.games.reduce((b, g) => b + g.markets.reduce((c, m) => c + m.outcomes.length, 0), 0), 0), 0)
          return json({ persisted, persistResult, counts: { sports: parsed.length, leagues: leagueCount, games: gameCount, markets: marketCount, outcomes: outcomeCount }, parsed })
        } catch (e) {
          return json({ error: String(e) }, 500)
        }
      }
      if (p.startsWith("/api/test/statscore/")) {
        const raw = decodeURIComponent(p.slice("/api/test/statscore/".length))
        const lsId = raw.startsWith("m:") ? raw.slice(2) : raw
        const wg = url.searchParams.get("wg") ?? "65c592e745164675a446d35b"
        const tz = url.searchParams.get("tz") ?? "0"
        const persist = url.searchParams.get("persist") === "1"
        try {
          const payload = await getStatscoreSSR(lsId, wg, "en", tz)
          const meta = parseStatscoreSSR(payload, lsId)
          let persisted = false
          if (persist) {
            const db = getClient(env)
            const provider_key = `statscore:ls:${lsId}`
            await upsertLiveMeta(db, [{
              provider_key,
              provider: "statscore",
              provider_ls_id: meta.provider_ls_id,
              provider_event_id: meta.provider_event_id,
              status_name: meta.status_name,
              clock_time: meta.clock_time ?? null,
              start_time: meta.start_time ?? null,
              home_team: meta.home_team ?? null,
              away_team: meta.away_team ?? null,
              home_score: meta.home_score ?? null,
              away_score: meta.away_score ?? null,
              competition_name: meta.competition_name ?? null
            }])
            persisted = true
          }
          return json({ lsId, widgetGroup: wg, timezone: tz, meta, persisted })
        } catch (e) {
          return json({ error: String(e) }, 500)
        }
      }
      if (p.startsWith("/api/test/match/")) {
        const matchId = decodeURIComponent(p.slice("/api/test/match/".length))
        try {
          const html = await getMatchOddsGroupedHTML(matchId)
          const markets = parseMatchOddsGrouped(html, matchId)
          return json({ matchId, markets })
        } catch (e) {
          return json({ error: String(e) }, 500)
        }
      }
      if (p.startsWith("/api/odds/prematch/")) {
        const sportKey = decodeURIComponent(p.slice("/api/odds/prematch/".length))
        return serveOdds(env, sportKey, false)
      }
      if (p.startsWith("/api/odds/live/")) {
        const sportKey = decodeURIComponent(p.slice("/api/odds/live/".length))
        return serveOdds(env, sportKey, true)
      }
    }
    return notFound()
  },
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    if (event.cron === "*/1 * * * *") {
      ctx.waitUntil(runLive(env))
    } else if (event.cron === "*/10 * * * *") {
      ctx.waitUntil(runPrematch(env))
    }
  }
}
