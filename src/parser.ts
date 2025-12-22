import type { ParsedMarket, ParsedOutcome } from "./domain"
import { decodeEntities, extractAttr, mapMarketKey, normalizeOutcomeLabel, parseDecimal } from "./parser/shared"

// Public surface: re-export from split modules
export { getSelectedSportIdFromNav } from "./parser/shared"
export { parsePrematch, parsePrematchNextMatches, parsePrematchSportMatchList, parsePopularMatchesFragment } from "./parser/prematch"
export { parseLive } from "./parser/live"

// Keep parseMatchOddsGrouped here as the grouped-odds parser used by services
export function parseMatchOddsGrouped(html: string, matchId: string): ParsedMarket[] {
  const markets: ParsedMarket[] = []
  const scope = html
  const starts: number[] = []
  const rowRe = /<div[^>]*class=["'][^"']*divOddRow[^"']*["'][^>]*>/gi
  let rm: RegExpExecArray | null
  while ((rm = rowRe.exec(scope)) !== null) starts.push(rm.index)
  if (!starts.length) return markets
  starts.push(scope.length)

  let currentMarketName: string | null = null
  const initialNameM = scope.match(/<div[^>]*class=["'][^"']*oddName[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)
  if (initialNameM) currentMarketName = decodeEntities(initialNameM[1].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim())

  for (let i = 0; i < starts.length - 1; i++) {
    const block = scope.slice(starts[i], starts[i + 1])
    const nameM = block.match(/<div[^>]*class=["'][^"']*oddName[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)
    if (nameM) currentMarketName = decodeEntities(nameM[1].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim())

    const hM = block.match(/<div[^>]*class=["']divOddSpecial["'][^>]*>[\s\S]*?<label[^>]*>([\s\S]*?)<\/label>/i)
    const handicap = hM ? Number((decodeEntities(hM[1]).trim()).replace(",", ".")) : null

    const oRe = /<(div|span)[^>]*data-matchoddid=["'](\d+)["'][^>]*>[\s\S]*?<\/\1>/gi
    let om: RegExpExecArray | null
    const outcomes: ParsedOutcome[] = []
    while ((om = oRe.exec(block)) !== null) {
      const full = om[0]
      const id = om[2]
      const openTag = full.match(/^<[^>]*>/i)?.[0] ?? ""
      if (!/class=["'][^"']*match-odd[^"']*["']/i.test(openTag)) continue
      const inner = full.replace(/^<[^>]*>/, "").replace(new RegExp(`<\\/${om[1]}>$`, "i"), "")
      const labelM = inner.match(/<label[^>]*>([\s\S]*?)<\/label>/i)
      const rawLabel = labelM ? labelM[1] : ""
      const label = normalizeOutcomeLabel(rawLabel)
      let price = NaN
      const priceTagAttr = extractAttr(openTag, "data-oddvaluedecimal")
      if (priceTagAttr) price = parseDecimal(priceTagAttr)
      if (isNaN(price)) {
        const textM = inner.match(/<span[^>]*class=["']quoteValue["'][^>]*>([\s\S]*?)<\/span>/i)
        if (textM) price = parseDecimal(textM[1].replace(/<[^>]*>/g, "").trim())
      }
      if (!isNaN(price)) outcomes.push({ label, price, handicap, external_id: id })
    }
    if (!outcomes.length) continue

    const marketName = currentMarketName ?? "Market"
    const keyBase = mapMarketKey(marketName)
    const key = handicap !== null ? `${keyBase}` : keyBase
    const external_id = handicap !== null ? `${keyBase}_${handicap}` : keyBase
    markets.push({ key, name: marketName, external_id: `${matchId}_${external_id}`, outcomes })
  }
  return markets
}
