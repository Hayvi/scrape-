import { getClient } from "../../db"
import type { Env } from "../../env"
import { json } from "../../http/response"

export async function handleTestStatsRoute(_request: Request, env: Env, url: URL, p: string): Promise<Response | null> {
  if (p !== "/api/test/stats") return null

  const db = getClient(env)
  const source = url.searchParams.get("source") ?? "tounesbet"
  const sportKey = url.searchParams.get("sportKey")
  try {
    let leagueIds: number[] | null = null
    if (sportKey) {
      const s = await db.from("sports").select("id").eq("source", source).eq("key", sportKey).maybeSingle()
      if (!s.data?.id) return json({ error: "sport not found", source, sportKey }, 404)
      const leagues = await db.from("leagues").select("id").eq("sport_id", s.data.id)
      leagueIds = (leagues.data ?? []).map((r: any) => Number(r.id)).filter((x: any) => Number.isFinite(x))
    }

    const nowIso = new Date().toISOString()
    const includeStale = url.searchParams.get("includeStale") === "1"
    const seenWithinMinutes = Math.max(0, Math.min(7 * 24 * 60, Number(url.searchParams.get("seenWithinMinutes") ?? "180") || 180))
    const seenCutoffIso = new Date(Date.now() - seenWithinMinutes * 60 * 1000).toISOString()

    let totalGamesQ = db
      .from("games")
      .select("id", { count: "exact", head: true })
      .eq("source", source)
      .eq("live", false)
    if (!includeStale && seenWithinMinutes > 0) totalGamesQ = totalGamesQ.gte("last_seen_at", seenCutoffIso)
    if (leagueIds) totalGamesQ = totalGamesQ.in("league_id", leagueIds)
    const totalGames = await totalGamesQ
    if (totalGames.error) throw new Error(`totalGames failed: ${JSON.stringify(totalGames.error)}`)

    let upcomingGamesQ = db
      .from("games")
      .select("id", { count: "exact", head: true })
      .eq("source", source)
      .eq("live", false)
      .gt("start_time", nowIso)
    if (!includeStale && seenWithinMinutes > 0) upcomingGamesQ = upcomingGamesQ.gte("last_seen_at", seenCutoffIso)
    if (leagueIds) upcomingGamesQ = upcomingGamesQ.in("league_id", leagueIds)
    const upcomingGames = await upcomingGamesQ
    if (upcomingGames.error) throw new Error(`upcomingGames failed: ${JSON.stringify(upcomingGames.error)}`)

    let startedGamesQ = db
      .from("games")
      .select("id", { count: "exact", head: true })
      .eq("source", source)
      .eq("live", false)
      .lte("start_time", nowIso)
    if (!includeStale && seenWithinMinutes > 0) startedGamesQ = startedGamesQ.gte("last_seen_at", seenCutoffIso)
    if (leagueIds) startedGamesQ = startedGamesQ.in("league_id", leagueIds)
    const startedGames = await startedGamesQ
    if (startedGames.error) throw new Error(`startedGames failed: ${JSON.stringify(startedGames.error)}`)

    const gamesWith1x2Market = await db
      .from("markets")
      .select("game_id", { count: "exact", head: true })
      .eq("source", source)
      .eq("key", "1x2")

    if (gamesWith1x2Market.error) throw new Error(`gamesWith1x2Market failed: ${JSON.stringify(gamesWith1x2Market.error)}`)

    let gamesWithComplete1x2: unknown = null
    let rpcError: unknown = null
    try {
      const complete1x2 = await db.rpc("stats_prematch_complete_1x2", { p_source: source })
      if (complete1x2.error) {
        rpcError = complete1x2.error
      } else {
        gamesWithComplete1x2 = (complete1x2.data?.[0]?.games_with_complete_1x2 ?? complete1x2.data ?? null) as any
      }
    } catch (e) {
      rpcError = String(e)
    }

    return json({
      ok: true,
      source,
      sportKey: sportKey ?? null,
      seen_filter: { includeStale, seenWithinMinutes, seenCutoffIso },
      totals: {
        games: totalGames.count ?? null,
        games_upcoming_strict: upcomingGames.count ?? null,
        games_started_or_now: startedGames.count ?? null,
        games_with_1x2_market: gamesWith1x2Market.count ?? null,
        games_with_complete_1x2: gamesWithComplete1x2
      },
      rpc_error: rpcError
    })
  } catch (e) {
    return json({ error: String(e) }, 500)
  }
}
