import type { Env } from "../../env"
import { json } from "../../http/response"
import { runPrematchDiscovery, runPrematchHourly } from "../../service"
import { getSportMatchListHTML } from "../../fetcher"
import { parsePrematchSportMatchList } from "../../parser"
import { persistParsed } from "../../services/persist"

export async function handleTestRunRoute(_request: Request, env: Env, url: URL, p: string): Promise<Response | null> {
  if (p === "/api/test/run/prematch_hourly") {
    const batch = Math.max(1, Math.min(8, Number(url.searchParams.get("batch") ?? "8") || 8))
    try {
      const res = await runPrematchHourly(env as any, batch)
      return json({ ok: true, batch, res })
    } catch (e) {
      return json({ error: String(e) }, 500)
    }
  }

  if (p === "/api/test/run/prematch_discovery_page") {
    const sportId = url.searchParams.get("sportId") ?? env.DEFAULT_SPORT_ID ?? "1181"
    const betRangeFilter = url.searchParams.get("betRangeFilter") ?? "0"
    const page = Math.max(1, Math.min(250, Number(url.searchParams.get("page") ?? "1") || 1))
    try {
      const html = await getSportMatchListHTML(String(sportId), String(betRangeFilter), page)
      const parsed = parsePrematchSportMatchList(html, String(sportId))
      const res = await persistParsed(env as any, parsed)
      const games = parsed.flatMap(s => s.leagues).flatMap(l => l.games)
      return json({ ok: true, sportId, betRangeFilter, page, parsed_games: games.length, persisted: res, sample: games.slice(0, 10).map(g => ({ id: g.external_id, start_time: g.start_time, home: g.home_team, away: g.away_team, markets: (g.markets ?? []).map((m: any) => ({ key: m.key, outcomes: (m.outcomes ?? []).length })) })) })
    } catch (e) {
      return json({ ok: false, error: String(e), sportId, betRangeFilter, page }, 200)
    }
  }

  if (p === "/api/test/run/prematch_discovery") {
    try {
      const batch = Math.max(1, Math.min(4, Number(url.searchParams.get("batch") ?? "3") || 3))
      const res = await runPrematchDiscovery(env as any, { batch })
      return json({ ok: true, batch, res })
    } catch (e) {
      return json({ ok: false, error: String(e) }, 200)
    }
  }

  return null
}
