import type { Env } from "../../env"
import { getTextWithDdosBypassDetailed } from "../../fetcher"
import { json } from "../../http/response"
import { parseMatchOddsGrouped } from "../../parser"

export async function handleTestMatchRoute(_request: Request, _env: Env, url: URL, p: string): Promise<Response | null> {
  if (!p.startsWith("/api/test/match/")) return null

  const matchId = decodeURIComponent(p.slice("/api/test/match/".length))
  const debug = url.searchParams.get("debug") === "1"
  try {
    const target = `https://tounesbet.com/Match/MatchOddsGrouped?matchId=${encodeURIComponent(String(matchId))}`
    const fetched = await getTextWithDdosBypassDetailed(target, {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      "x-requested-with": "XMLHttpRequest"
    })

    const html = fetched.text
    const markets = parseMatchOddsGrouped(html, matchId)

    if (debug) {
      const signals = {
        divOddRowTag: (html.match(/<div[^>]*class=["'][^"']*divOddRow[^"']*["'][^>]*>/gi) ?? []).length,
        oddNameTag: (html.match(/<div[^>]*class=["'][^"']*oddName[^"']*["'][^>]*>/gi) ?? []).length,
        dataMatchOddId: (html.match(/data-matchoddid=/gi) ?? []).length,
        matchOddClass: (html.match(/class=["'][^"']*match-odd/gi) ?? []).length,
        quoteValue: (html.match(/class=["']quoteValue["']/gi) ?? []).length
      }
      const firstOddIdx = html.search(/data-matchoddid=/i)
      const firstOddSnippet = firstOddIdx >= 0
        ? html.slice(Math.max(0, firstOddIdx - 250), Math.min(html.length, firstOddIdx + 900)).replace(/\s+/g, " ").trim()
        : null
      return json({
        matchId,
        fetch: { target, status: fetched.status, contentType: fetched.contentType, length: html.length, finalUrl: fetched.finalUrl },
        signals,
        parse: { markets: markets.length, outcomes: markets.reduce((a, m) => a + (m.outcomes?.length ?? 0), 0) },
        firstOddSnippet,
        markets
      })
    }

    return json({ matchId, markets })
  } catch (e) {
    return json({ error: String(e) }, 500)
  }
}
