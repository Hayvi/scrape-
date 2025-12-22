import type { Env } from "../../env"
import { getSportMatchListHTML, getTextWithDdosBypassDetailed } from "../../fetcher"
import { json } from "../../http/response"
import { parsePrematchNextMatches, parsePrematchSportMatchList } from "../../parser"

export async function handleTestMatchlistRoutes(_request: Request, env: Env, url: URL, p: string): Promise<Response | null> {
  if (p === "/api/test/matchlist_parse_debug") {
    const sportId = url.searchParams.get("sportId") ?? env.DEFAULT_SPORT_ID ?? "1181"
    const betRangeFilter = url.searchParams.get("betRangeFilter") ?? "0"
    const page = Math.max(1, Math.min(250, Number(url.searchParams.get("page") ?? "1") || 1))
    try {
      const html = await getSportMatchListHTML(String(sportId), String(betRangeFilter), page)
      const nowMs = Date.now()
      const parsed = parsePrematchNextMatches(html, String(sportId))
      const parsed2 = parsePrematchSportMatchList(html, String(sportId))
      const games = parsed2.flatMap(s => s.leagues).flatMap(l => l.games)
      const fallback = games.filter(g => {
        const t = Date.parse(String(g.start_time))
        return Number.isFinite(t) && Math.abs(t - nowMs) < 2 * 60 * 1000
      }).length

      const fullDates = (html.match(/\d{2}\/\d{2}\/\d{4}/g) ?? []).length
      const shortDates = (html.match(/\d{2}\/\d{2}(?!\/\d{4})/g) ?? []).length
      const times = (html.match(/\b\d{2}:\d{2}(?::\d{2})?\b/g) ?? []).length
      const matchIds = Array.from(new Set((html.match(/data-matchid=["'](\d+)["']/gi) ?? []).map(x => x.match(/(\d+)/)?.[1]).filter(Boolean)))

      return json({
        sportId,
        betRangeFilter,
        page,
        fetched: {
          length: html.length,
          snippet: html.slice(0, 1200).replace(/\s+/g, " ").trim()
        },
        html_stats: { match_ids: matchIds.length, full_dates: fullDates, short_dates: shortDates, times },
        parsed_stats: {
          parsed_games: games.length,
          fallback_start_time_count: fallback,
          next_matches_parser_games: parsed.flatMap(s => s.leagues).flatMap(l => l.games).length
        },
        sample: games.slice(0, 8).map(g => ({ id: g.external_id, start_time: g.start_time, home: g.home_team, away: g.away_team }))
      })
    } catch (e) {
      return json({ error: String(e), sportId, betRangeFilter, page }, 500)
    }
  }

  if (p === "/api/test/matchlist_fetch_debug") {
    const sportId = url.searchParams.get("sportId") ?? env.DEFAULT_SPORT_ID ?? "1181"
    const betRangeFilter = url.searchParams.get("betRangeFilter") ?? "0"
    const page = Math.max(1, Math.min(250, Number(url.searchParams.get("page") ?? "1") || 1))
    const variant = (url.searchParams.get("variant") ?? "both").toLowerCase()
    const xhr = url.searchParams.get("xhr") !== "0"
    const dateDay = url.searchParams.get("dateDay")

    const baseHeaders: Record<string, string> = {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
    }
    if (xhr) baseHeaders["x-requested-with"] = "XMLHttpRequest"

    const dateDayQs = dateDay ? `&DateDay=${encodeURIComponent(String(dateDay))}` : ""
    const qsNew = `BetRangeFilter=${encodeURIComponent(String(betRangeFilter))}&Page_number=${encodeURIComponent(String(page))}&d=1${dateDayQs}`
    const qsLegacy = `SportId=${encodeURIComponent(String(sportId))}&BetRangeFilter=${encodeURIComponent(String(betRangeFilter))}&Page_number=${encodeURIComponent(String(page))}&d=1${dateDayQs}`
    const targets: { kind: string; url: string }[] = []
    if (variant === "new" || variant === "both") {
      targets.push({ kind: "new_https", url: `https://tounesbet.com/Sport/${encodeURIComponent(String(sportId))}?${qsNew}` })
      targets.push({ kind: "new_http", url: `http://tounesbet.com/Sport/${encodeURIComponent(String(sportId))}?${qsNew}` })
    }
    if (variant === "legacy" || variant === "both") {
      targets.push({ kind: "legacy_https", url: `https://tounesbet.com/Sport/matchList?${qsLegacy}` })
      targets.push({ kind: "legacy_http", url: `http://tounesbet.com/Sport/matchList?${qsLegacy}` })
    }

    const results: any[] = []
    for (const t of targets) {
      try {
        const res = await getTextWithDdosBypassDetailed(t.url, baseHeaders)
        const text = res.text
        const matchIdCount = (text.match(/data-matchid=["']\d+["']/gi) ?? []).length
        const signals = {
          matchIdCount,
          matchesTableBody: (text.match(/matchesTableBody/gi) ?? []).length,
          ddosGate: /document\.cookie\s*=\s*"[^";=]+=[^;]+\s*;\s*path=\//i.test(text),
          cloudflare: /cloudflare|attention required|cf-ray|checking your browser/i.test(text)
        }
        results.push({ kind: t.kind, target: t.url, status: res.status, finalUrl: res.finalUrl, contentType: res.contentType, length: text.length, signals, snippet: text.slice(0, 1200).replace(/\s+/g, " ").trim() })
      } catch (e) {
        results.push({ kind: t.kind, target: t.url, error: String(e) })
      }
    }
    return json({ sportId, betRangeFilter, page, variant, xhr, dateDay: dateDay ?? null, results })
  }

  return null
}
