import type { Env } from "../../env"
import { getTextWithDdosBypassDetailed } from "../../fetcher"
import { json } from "../../http/response"
import { extractMatchIdsFromText, snippetAround } from "../../http/utils"

export async function handleTestProbeRoute(_request: Request, _env: Env, url: URL, p: string): Promise<Response | null> {
  if (p !== "/api/test/probe") return null

  const rawPath = url.searchParams.get("path")
  if (!rawPath) return json({ error: "missing path" }, 400)
  const needle = url.searchParams.get("needle")
  const xhr = url.searchParams.get("xhr") !== "0"
  const target = rawPath.startsWith("http") ? rawPath : `https://tounesbet.com${rawPath.startsWith("/") ? "" : "/"}${rawPath}`
  try {
    const headers: Record<string, string> = {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
    }
    if (xhr) headers["x-requested-with"] = "XMLHttpRequest"
    const res = await getTextWithDdosBypassDetailed(target, headers)
    const ids = extractMatchIdsFromText(res.text, 50)
    const signals = {
      divOddRow: (res.text.match(/divOddRow/gi) ?? []).length,
      divOddRowTag: (res.text.match(/<div[^>]*class=["'][^"']*divOddRow[^"']*["'][^>]*>/gi) ?? []).length,
      divOddsTableTag: (res.text.match(/<div[^>]*class=["'][^"']*divOddsTable[^"']*["'][^>]*>/gi) ?? []).length,
      dataMatchOddId: (res.text.match(/data-matchoddid=/gi) ?? []).length,
      matchOddClass: (res.text.match(/class=["'][^"']*match-odd/gi) ?? []).length,
      quoteValue: (res.text.match(/class=["']quoteValue["']/gi) ?? []).length
    }

    const firstNameIdx = res.text.search(/<div[^>]*class=["'][^"']*oddName[^"']*["'][^>]*>/i)
    const firstOddNameSnippet = firstNameIdx >= 0
      ? res.text.slice(Math.max(0, firstNameIdx - 300), Math.min(res.text.length, firstNameIdx + 900)).replace(/\s+/g, " ").trim()
      : null

    const firstTableIdx = res.text.search(/<div[^>]*class=["'][^"']*divOddsTable[^"']*["'][^>]*>/i)
    const firstDivOddsTableSnippet = firstTableIdx >= 0
      ? res.text.slice(Math.max(0, firstTableIdx - 200), Math.min(res.text.length, firstTableIdx + 900)).replace(/\s+/g, " ").trim()
      : null

    const firstOddIdx = res.text.search(/data-matchoddid=/i)
    const firstOddSnippet = firstOddIdx >= 0
      ? res.text.slice(Math.max(0, firstOddIdx - 300), Math.min(res.text.length, firstOddIdx + 900)).replace(/\s+/g, " ").trim()
      : null

    const firstRowIdx = res.text.search(/class=["'][^"']*divOddRow[^"']*["']/i)
    let firstRowSignals: any = null
    if (firstRowIdx >= 0) {
      const rowWindow = res.text.slice(firstRowIdx, Math.min(res.text.length, firstRowIdx + 20000))
      const nextRowRel = rowWindow.slice(1).search(/class=["'][^"']*divOddRow[^"']*["']/i)
      const rowBlock = nextRowRel >= 0 ? rowWindow.slice(0, nextRowRel + 1) : rowWindow
      firstRowSignals = {
        length: rowBlock.length,
        dataMatchOddId: (rowBlock.match(/data-matchoddid=/gi) ?? []).length,
        matchOddClass: (rowBlock.match(/class=["'][^"']*match-odd/gi) ?? []).length,
        quoteValue: (rowBlock.match(/class=["']quoteValue["']/gi) ?? []).length
      }
    }

    const snippet = res.text.slice(0, 2000).replace(/\s+/g, " ").trim()
    const needleSnippet = needle ? snippetAround(res.text, needle, 1800) : null
    return json({
      target,
      status: res.status,
      contentType: res.contentType,
      length: res.text.length,
      xhr,
      signals,
      firstOddSnippet,
      firstOddNameSnippet,
      firstDivOddsTableSnippet,
      firstRowSignals,
      matchIdCount: ids.length,
      matchIds: ids.slice(0, 25),
      needle,
      needleSnippet,
      snippet
    })
  } catch (e) {
    return json({ target, error: String(e) }, 500)
  }
}
