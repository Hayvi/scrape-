import { getTextWithDdosBypassDetailed } from "../fetcher"
import { parseMatchOddsGrouped } from "../parser"

export function pick1x2Only(markets: any[]) {
  const arr = Array.isArray(markets) ? markets : []
  const m = arr.find(x => String(x?.key ?? "").toLowerCase() === "1x2")
    ?? arr.find(x => String(x?.name ?? "").toLowerCase().includes("1x2"))
  return m ? [m] : []
}

export async function fetchMatchMarkets(matchId: string) {
  const headers = {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    "x-requested-with": "XMLHttpRequest"
  }
  const qs = `matchId=${encodeURIComponent(matchId)}`
  const urls = [`https://tounesbet.com/Match/MatchOddsGrouped?${qs}`, `http://tounesbet.com/Match/MatchOddsGrouped?${qs}`]

  let last: { status: number; finalUrl: string; text: string; contentType: string | null } | null = null
  for (const u of urls) {
    const fetched = await getTextWithDdosBypassDetailed(u, headers)
    last = fetched
    if (fetched.status >= 200 && fetched.status < 300) {
      return parseMatchOddsGrouped(fetched.text, matchId)
    }
  }
  throw new Error(`MatchOddsGrouped failed status=${last?.status} url=${last?.finalUrl}`)
}
