import type { Env } from "../../env"
import { getNextMatchesHTML, getTextWithDdosBypassDetailed } from "../../fetcher"
import { json } from "../../http/response"
import { capMarkets } from "../../http/utils"
import { parseMatchOddsGrouped, parsePrematchNextMatches } from "../../parser"
import { persistParsed } from "../../service"

export async function handleTestPrematchRoute(_request: Request, env: Env, url: URL, p: string): Promise<Response | null> {
  if (p !== "/api/test/prematch") return null

  const persist = url.searchParams.get("persist") === "1"
  const deep = url.searchParams.get("deep") === "1"
  const limit = Math.max(1, Math.min(25, Number(url.searchParams.get("limit") ?? "10") || 10))
  try {
    const sportId = env.DEFAULT_SPORT_ID || "1181"
    const html = await getNextMatchesHTML(sportId)
    let parsed = parsePrematchNextMatches(html, sportId)

    if (deep && parsed.length) {
      const games = parsed.flatMap(s => s.leagues).flatMap(l => l.games)
      const deepLimit = Math.min(games.length, Math.min(limit, 3))
      for (let i = 0; i < deepLimit; i++) {
        const g = games[i]
        try {
          const fetched = await getTextWithDdosBypassDetailed(`https://tounesbet.com/Match/MatchOddsGrouped?matchId=${encodeURIComponent(g.external_id)}`, {
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "accept-language": "en-US,en;q=0.9",
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
            "x-requested-with": "XMLHttpRequest"
          })
          if (fetched.status >= 200 && fetched.status < 300) {
            g.markets = capMarkets(parseMatchOddsGrouped(fetched.text, g.external_id))
          }
        } catch {
        }
      }
    }

    let persisted = false
    let persistResult: any = null
    if (persist) {
      persistResult = await persistParsed(env as any, parsed)
      persisted = true
    }

    const leagueCount = parsed.reduce((acc, s) => acc + s.leagues.length, 0)
    const gameCount = parsed.reduce((acc, s) => acc + s.leagues.reduce((a, l) => a + l.games.length, 0), 0)
    const marketCount = parsed.reduce((acc, s) => acc + s.leagues.reduce((a, l) => a + l.games.reduce((b, g) => b + g.markets.length, 0), 0), 0)
    const outcomeCount = parsed.reduce(
      (acc, s) =>
        acc +
        s.leagues.reduce(
          (a, l) =>
            a +
            l.games.reduce(
              (b, g) => b + g.markets.reduce((c, m) => c + m.outcomes.length, 0),
              0
            ),
          0
        ),
      0
    )

    return json({ persisted, persistResult, counts: { sports: parsed.length, leagues: leagueCount, games: gameCount, markets: marketCount, outcomes: outcomeCount }, parsed })
  } catch (e) {
    return json({ error: String(e) }, 500)
  }
}
