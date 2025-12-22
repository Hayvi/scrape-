import type { Env } from "../../env"
import { getTextWithDdosBypass, getTextWithDdosBypassDetailed } from "../../fetcher"
import { json } from "../../http/response"

export async function handleTestMatchlistJsRoute(_request: Request, env: Env, url: URL, p: string): Promise<Response | null> {
  if (p !== "/api/test/matchlist_js") return null

  const sportId = url.searchParams.get("sportId") ?? env.DEFAULT_SPORT_ID ?? "1181"
  const betRangeFilter = url.searchParams.get("betRangeFilter") ?? "0"
  const base = "https://tounesbet.com"
  const pageUrl = `${base}/Sport/matchList?SportId=${encodeURIComponent(String(sportId))}&BetRangeFilter=${encodeURIComponent(String(betRangeFilter))}`
  try {
    const htmlRes = await getTextWithDdosBypassDetailed(pageUrl, {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
    })
    const html = htmlRes.text
    const m = html.match(/<script[^>]*\ssrc=["']([^"']*\/bundles\/flashbet-libs\?v=[^"']+)["'][^>]*>/i)
    const src = m ? m[1] : null
    if (!src) return json({ error: "flashbet-libs bundle not found", pageUrl: htmlRes.finalUrl }, 500)
    const fullSrc = src.startsWith("http") ? src : `${base}${src}`

    const js = await getTextWithDdosBypass(fullSrc, {
      accept: "text/javascript,application/javascript,*/*;q=0.1",
      "accept-language": "en-US,en;q=0.9",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
    })
    const needle = "function matchList("
    const idx = js.indexOf(needle)
    if (idx < 0) return json({ error: "matchList() function not found in bundle", bundle: fullSrc }, 500)
    const snippet = js.slice(idx, Math.min(js.length, idx + 12000)).replace(/\s+/g, " ").trim()
    return json({
      pageUrl: htmlRes.finalUrl,
      bundle: fullSrc,
      snippet
    })
  } catch (e) {
    return json({ error: String(e), pageUrl }, 500)
  }
}
