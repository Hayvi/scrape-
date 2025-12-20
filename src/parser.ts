import { ParsedSport, ParsedLeague } from "./domain"

function decodeEntities(s: string): string {
  // Minimal HTML entity decoding for our use-case
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
}

function normalizeOutcomeLabel(label: string): string {
  const t = decodeEntities(label).trim()
  if (/^plus$/i.test(t) || /^over$/i.test(t)) return "Over"
  if (/^moins$/i.test(t) || /^under$/i.test(t)) return "Under"
  if (/^oui$/i.test(t) || /^yes$/i.test(t)) return "Yes"
  if (/^non$/i.test(t) || /^no$/i.test(t)) return "No"
  return t
}

function mapMarketKey(name: string): string {
  const n = decodeEntities(name).toLowerCase()
  if (n.includes("1x2")) return "1x2"
  if (n.includes("double chance")) return "double_chance"
  if (n.includes("les deux") || n.includes("both")) return "btts"
  if (n.includes("total") || n.includes("under / over") || n.includes("under/over")) return "totals"
  if (n.includes("mt/r.fin") || n.includes("mt/r.fin")) return "ht_ft"
  if (n.includes("score exact")) return "correct_score"
  return slugify(n).replace(/[^a-z0-9_-]/g, "-") || "other"
}

export function parseMatchOddsGrouped(html: string, matchId: string): import("./domain").ParsedMarket[] {
  const markets: import("./domain").ParsedMarket[] = []
  const scope = html
  const starts: number[] = []
  const rowRe = /<div[^>]*class=["'][^"']*divOddRow[^"']*["'][^>]*>/gi
  let rm: RegExpExecArray | null
  while ((rm = rowRe.exec(scope)) !== null) starts.push(rm.index)
  if (!starts.length) return markets
  starts.push(scope.length)

  let currentMarketName: string | null = null

  for (let i = 0; i < starts.length - 1; i++) {
    const block = scope.slice(starts[i], starts[i + 1])
    const nameM = block.match(/<div[^>]*class=["']oddName["'][^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i)
    if (nameM) currentMarketName = decodeEntities(nameM[1]).trim()
    if (!currentMarketName) continue

    const hM = block.match(/<div[^>]*class=["']divOddSpecial["'][^>]*>[\s\S]*?<label[^>]*>([\s\S]*?)<\/label>/i)
    const handicap = hM ? Number((decodeEntities(hM[1]).trim()).replace(",", ".")) : null

    const oRe = /<div[^>]*class=["']match-odd["'][^>]*data-matchoddid=["'](\d+)["'][^>]*>([\s\S]*?)<\/div>/gi
    let om: RegExpExecArray | null
    const outcomes: import("./domain").ParsedOutcome[] = []
    while ((om = oRe.exec(block)) !== null) {
      const id = om[1]
      const inner = om[2]
      const labelM = inner.match(/<label[^>]*>([\s\S]*?)<\/label>/i)
      const rawLabel = labelM ? labelM[1] : ""
      const label = normalizeOutcomeLabel(rawLabel)
      let price = NaN
      const priceAttr = inner.match(/data-oddvaluedecimal='([^']+)'/i)
      if (priceAttr) price = parseDecimal(priceAttr[1])
      if (isNaN(price)) {
        const textM = inner.match(/<span[^>]*class=["']quoteValue["'][^>]*>([\s\S]*?)<\/span>/i)
        if (textM) price = parseDecimal(textM[1].replace(/<[^>]*>/g, "").trim())
      }
      if (!isNaN(price)) outcomes.push({ label, price, handicap, external_id: id })
    }
    if (!outcomes.length) continue

    const marketName = currentMarketName
    const keyBase = mapMarketKey(marketName)
    const key = handicap !== null ? `${keyBase}` : keyBase
    const external_id = handicap !== null ? `${keyBase}_${handicap}` : keyBase
    markets.push({ key, name: marketName, external_id: `${matchId}_${external_id}`, outcomes })
  }
  return markets
}

function slugify(input: string): string {
  return decodeEntities(input)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function extractSportsFromNav(html: string): ParsedSport[] {
  // Attempt to isolate the nav block first for efficiency
  const navMatch = html.match(/<nav[^>]*id=["']main_nav["'][^>]*>[\s\S]*?<\/nav>/i)
  const scope = navMatch ? navMatch[0] : html
  const items: ParsedSport[] = []
  const itemRe = /<a[^>]*class=["'][^"']*sport_item[^"']*["'][^>]*data-sportid=["'](\d+)["'][\s\S]*?<span[^>]*class=["'][^"']*menu-sport-name[^"']*["'][^>]*>([\s\S]*?)<\/span>[\s\S]*?<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = itemRe.exec(scope)) !== null) {
    const id = m[1]
    const rawName = m[2]
    const name = decodeEntities(rawName).trim()
    const key = slugify(name)
    items.push({ key, name, external_id: id, leagues: [] })
  }
  return items
}

export function getSelectedSportIdFromNav(html: string): string | null {
  const navMatch = html.match(/<nav[^>]*id=["']main_nav["'][^>]*>[\s\S]*?<\/nav>/i)
  const scope = navMatch ? navMatch[0] : html
  const m = scope.match(/<a[^>]*class=["'][^"']*sport_item[^"']*selected[^"']*["'][^>]*data-sportid=["'](\d+)["'][^>]*>/i)
  return m ? m[1] : null
}

function parseDecimal(fr: string): number {
  const cleaned = fr.trim().replace(/[^0-9,\.\-]/g, "")
  if (cleaned.includes(",") && !cleaned.includes(".")) {
    return Number(cleaned.replace(/\./g, "").replace(/,/g, "."))
  }
  return Number(cleaned.replace(/,/g, ""))
}

function extractPopularMatches(html: string) {
  const out: { home: string; away: string; start: string; outcomes: { id: string; label: string; price: number }[] }[] = []
  // Narrow to the slider container if present
  const containerMatch = html.match(/<div[^>]*class=["'][^"']*popular_matches_slider[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)
  const scope = containerMatch ? containerMatch[1] : html
  const starts: number[] = []
  const blocks: string[] = []
  const re = /class=["'][^"']*popular-slider-item[^"']*["'][^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(scope)) !== null) {
    starts.push(m.index)
  }
  if (!starts.length) return out
  starts.push(scope.length)
  for (let i = 0; i < starts.length - 1; i++) {
    blocks.push(scope.slice(starts[i], starts[i + 1]))
  }
  for (const b of blocks) {
    // Team names (either div or span with text-transform: uppercase)
    const teamRe = /<(?:div|span)[^>]*style=["'][^"']*text-transform:\s*uppercase[^"']*["'][^>]*>([^<]+)<\/(?:div|span)>/gi
    const teams: string[] = []
    let tm: RegExpExecArray | null
    while ((tm = teamRe.exec(b)) !== null) {
      const t = decodeEntities(tm[1]).trim()
      if (t) teams.push(t)
      if (teams.length === 2) break
    }
    if (teams.length < 2) continue
    // Date and time
    const dateM = b.match(/>(\d{2}\/\d{2}\/\d{4})</)
    const timeM = b.match(/>(\d{2}:\d{2}:\d{2})</)
    let startIso = new Date().toISOString()
    if (dateM && timeM) {
      const [d, mth, y] = dateM[1].split("/")
      startIso = new Date(`${y}-${mth}-${d}T${timeM[1]}Z`).toISOString()
    }
    // Outcomes 1, X, 2
    const outRe = /class=["']match-odd\s+quoteValue["'][^>]*data-matchoddid=["'](\d+)["'][^>]*data-oddvaluedecimal='([^']+)'[\s\S]*?<span[^>]*>([12X])<\/span>/gi
    const oc: { id: string; label: string; price: number }[] = []
    let om: RegExpExecArray | null
    while ((om = outRe.exec(b)) !== null) {
      oc.push({ id: om[1], label: om[3] as "1" | "X" | "2", price: parseDecimal(om[2]) })
    }
    if (!oc.length) continue
    out.push({ home: teams[0], away: teams[1], start: startIso, outcomes: oc })
  }
  return out
}

function extractLiveTable(html: string) {
  const tableMatch = html.match(/<table[^>]*id=["']live_matches_table["'][^>]*>[\s\S]*?<\/table>/i)
  const scope = tableMatch ? tableMatch[0] : html

  const sections: { name: string; matches: string[] }[] = []
  const headerRe = /<tr[^>]*class=["'][^"']*live_match_list_header[^"']*["'][^>]*>[\s\S]*?<div[^>]*class=["']category-tournament-title["'][^>]*>([\s\S]*?)<\/div>[\s\S]*?<\/tr>/gi
  const indices: { idx: number; name: string }[] = []
  let hm: RegExpExecArray | null
  while ((hm = headerRe.exec(scope)) !== null) {
    const name = decodeEntities(hm[1]).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()
    indices.push({ idx: hm.index, name })
  }
  if (!indices.length) return sections
  indices.push({ idx: scope.length, name: "" })

  for (let i = 0; i < indices.length - 1; i++) {
    const start = indices[i].idx
    const end = indices[i + 1].idx
    const block = scope.slice(start, end)
    const matchBlocks: string[] = []
    const matchRe = /<tr[^>]*class=["'][^"']*trMatch[^"']*live_match_data[^"']*["'][^>]*data-matchid=["'](\d+)["'][\s\S]*?<\/tr>/gi
    let mm: RegExpExecArray | null
    while ((mm = matchRe.exec(block)) !== null) {
      matchBlocks.push(mm[0])
    }
    if (matchBlocks.length) sections.push({ name: indices[i].name, matches: matchBlocks })
  }
  return sections
}

function extractAttr(tag: string, name: string): string | null {
  const re = new RegExp(`${name}=(?:"([^"]*)"|'([^']*)')`, "i")
  const m = tag.match(re)
  return m ? (m[1] ?? m[2] ?? null) : null
}

function parseMatchOddsFromColumn(tdHtml: string) {
  const spans: { tag: string; value: string }[] = []
  const spanRe = /<span[^>]*class=["'][^"']*match-odd[^"']*["'][^>]*>[\s\S]*?<\/span>/gi
  let sm: RegExpExecArray | null
  while ((sm = spanRe.exec(tdHtml)) !== null) {
    const full = sm[0]
    const openTag = full.match(/<span[^>]*>/i)?.[0] ?? ""
    const text = decodeEntities(full.replace(/^[\s\S]*?>/, "").replace(/<\/span>[\s\S]*$/, "")).trim()
    spans.push({ tag: openTag, value: text })
  }
  return spans
}

function parseLiveMatchRow(rowHtml: string) {
  const matchId = rowHtml.match(/data-matchid=["'](\d+)["']/i)?.[1] ?? null
  if (!matchId) return null

  const home = rowHtml.match(/<div[^>]*class=["']competitor1-name["'][^>]*>([\s\S]*?)<\/div>/i)?.[1]
  const away = rowHtml.match(/<div[^>]*class=["']competitor2-name["'][^>]*>([\s\S]*?)<\/div>/i)?.[1]
  if (!home || !away) return null

  const timeRaw = rowHtml.match(/<label[^>]*class=["'][^"']*match_time[^"']*["'][^>]*>([\s\S]*?)<\/label>/i)?.[1] ?? ""
  const match_time = decodeEntities(timeRaw).replace(/\s+/g, " ").trim()
  const scoreRaw = rowHtml.match(/<div[^>]*class=["'][^"']*match_score[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? ""
  const score = decodeEntities(scoreRaw).replace(/\s+/g, " ").trim()

  const tds: string[] = []
  const tdRe = /<td[^>]*class=["'][^"']*betColumn[^"']*main-market-no_\d+[^"']*["'][^>]*>[\s\S]*?<\/td>/gi
  let tm: RegExpExecArray | null
  while ((tm = tdRe.exec(rowHtml)) !== null) tds.push(tm[0])

  const markets: import("./domain").ParsedMarket[] = []
  const nowIso = new Date().toISOString()

  if (tds[0]) {
    const spans = parseMatchOddsFromColumn(tds[0])
    const labels = ["1", "X", "2"]
    const outcomes: import("./domain").ParsedOutcome[] = []
    for (let i = 0; i < Math.min(spans.length, labels.length); i++) {
      const isActive = (extractAttr(spans[i].tag, "data-isactive") ?? "True").toLowerCase() !== "false"
      const val = extractAttr(spans[i].tag, "data-oddvaluedecimal")
      const ext = extractAttr(spans[i].tag, "data-matchoddvaluetype") ?? `${matchId}_${i}`
      if (isActive && val) outcomes.push({ label: labels[i], price: parseDecimal(val), handicap: null, external_id: `live_${matchId}_${ext}` })
    }
    if (outcomes.length) markets.push({ key: "1x2", name: "1X2", external_id: `${matchId}_1x2`, outcomes })
  }

  if (tds[1]) {
    const spans = parseMatchOddsFromColumn(tds[1])
    const labels = ["Under", "Over"]
    const outcomes: import("./domain").ParsedOutcome[] = []
    for (let i = 0; i < Math.min(spans.length, labels.length); i++) {
      const isActive = (extractAttr(spans[i].tag, "data-isactive") ?? "True").toLowerCase() !== "false"
      const val = extractAttr(spans[i].tag, "data-oddvaluedecimal")
      const ratio = extractAttr(spans[i].tag, "data-matchoddvalueratio")
      const handicap = ratio ? parseDecimal(ratio) : null
      const ext = extractAttr(spans[i].tag, "data-matchoddvaluetype") ?? `${matchId}_ou_${i}`
      if (isActive && val) outcomes.push({ label: labels[i], price: parseDecimal(val), handicap, external_id: `live_${matchId}_${ext}` })
    }
    if (outcomes.length) markets.push({ key: "totals", name: "Under/Over", external_id: `${matchId}_totals`, outcomes })
  }

  if (tds[2]) {
    const spans = parseMatchOddsFromColumn(tds[2])
    const labels = ["1X", "12", "X2"]
    const outcomes: import("./domain").ParsedOutcome[] = []
    for (let i = 0; i < Math.min(spans.length, labels.length); i++) {
      const isActive = (extractAttr(spans[i].tag, "data-isactive") ?? "True").toLowerCase() !== "false"
      const val = extractAttr(spans[i].tag, "data-oddvaluedecimal")
      const ext = extractAttr(spans[i].tag, "data-matchoddvaluetype") ?? `${matchId}_dc_${i}`
      if (isActive && val) outcomes.push({ label: labels[i], price: parseDecimal(val), handicap: null, external_id: `live_${matchId}_${ext}` })
    }
    if (outcomes.length) markets.push({ key: "double_chance", name: "Double Chance", external_id: `${matchId}_double_chance`, outcomes })
  }

  if (tds[3]) {
    const spans = parseMatchOddsFromColumn(tds[3])
    const labels = ["Yes", "No"]
    const outcomes: import("./domain").ParsedOutcome[] = []
    for (let i = 0; i < Math.min(spans.length, labels.length); i++) {
      const isActive = (extractAttr(spans[i].tag, "data-isactive") ?? "True").toLowerCase() !== "false"
      const val = extractAttr(spans[i].tag, "data-oddvaluedecimal")
      const ext = extractAttr(spans[i].tag, "data-matchoddvaluetype") ?? `${matchId}_btts_${i}`
      if (isActive && val) outcomes.push({ label: labels[i], price: parseDecimal(val), handicap: null, external_id: `live_${matchId}_${ext}` })
    }
    if (outcomes.length) markets.push({ key: "btts", name: "Both Teams To Score", external_id: `${matchId}_btts`, outcomes })
  }

  return {
    external_id: matchId,
    home_team: decodeEntities(home).trim(),
    away_team: decodeEntities(away).trim(),
    start_time: nowIso,
    live: true,
    markets,
    extra: { match_time, score }
  }
}

export function parsePrematch(html: string): ParsedSport[] {
  // Only return the sports list; Popular Matches are fetched via dedicated endpoint and merged in service
  const sports = extractSportsFromNav(html)
  return sports
}

export function parsePopularMatchesFragment(html: string, sportId: string): ParsedLeague | null {
  const pop = extractPopularMatches(html)
  if (!pop.length) return null
  const league: ParsedLeague = {
    name: "Popular Matches",
    external_id: `popular_${sportId}`,
    games: pop.map((g, idx) => {
      const outcomeIds = g.outcomes.map(o => o.id).sort().join("-")
      const gameId = `pop_${outcomeIds || idx}`
      return {
        external_id: gameId,
        home_team: g.home,
        away_team: g.away,
        start_time: g.start,
        live: false,
        markets: [
          {
            key: "1x2",
            name: "Full Time Result",
            external_id: `1x2_${gameId}`,
            outcomes: g.outcomes.map(o => ({ label: o.label, price: o.price, handicap: null, external_id: o.id }))
          }
        ]
      }
    })
  }
  return league
}

function extractCurrentLive(html: string) {
  const out: { id: string; home: string; away: string }[] = []
  const listMatch = html.match(/<div[^>]*id=["']current_live_widget["'][^>]*>([\s\S]*?)<\/div>/i)
  const scope = listMatch ? listMatch[1] : html
  const liRe = /<li[^>]*class=["'][^"']*current-lives-div[^"']*["'][^>]*data-matchid=["'](\d+)["'][\s\S]*?<\/li>/gi
  let m: RegExpExecArray | null
  while ((m = liRe.exec(scope)) !== null) {
    const block = m[0]
    const id = m[1]
    const homeM = block.match(/<div class=["']cli-first-col["']>\s*([^<]+?)\s*<\/div>\s*<div class=["']cli-second-col match_score_home["']>/i)
    const awayM = block.match(/<div class=["']cli-first-col["']>\s*([^<]+?)\s*<\/div>\s*<div class=["']cli-second-col match_score_away["']>/i)
    if (homeM && awayM) {
      out.push({ id, home: decodeEntities(homeM[1]).trim(), away: decodeEntities(awayM[1]).trim() })
    }
  }
  return out
}

function extractUpcomingLive(html: string) {
  const out: { id: string; home: string; away: string }[] = []
  const listMatch = html.match(/<div[^>]*id=["']upcoming_live_widget["'][^>]*>([\s\S]*?)<\/div>/i)
  const scope = listMatch ? listMatch[1] : html
  const liRe = /<li[^>]*id=["']live_match_data["'][^>]*data-matchid=["'](\d+)["'][\s\S]*?<\/li>/gi
  let m: RegExpExecArray | null
  while ((m = liRe.exec(scope)) !== null) {
    const block = m[0]
    const id = m[1]
    // First two cli-first-col blocks are teams
    const teamRe = /<div class=["']cli-first-col["']>\s*([^<]+?)\s*<\/div>/gi
    const teams: string[] = []
    let tm: RegExpExecArray | null
    while ((tm = teamRe.exec(block)) !== null) {
      const t = decodeEntities(tm[1]).trim()
      if (t) teams.push(t)
      if (teams.length === 2) break
    }
    if (teams.length === 2) out.push({ id, home: teams[0], away: teams[1] })
  }
  return out
}

export function parseLive(html: string): ParsedSport[] {
  // Attempt to derive selected sport; default to Football if unknown
  const selectedSportId = getSelectedSportIdFromNav(html) || "1181"
  const sportKey = selectedSportId === "1181" ? "football" : `sport-${selectedSportId}`
  const sportName = selectedSportId === "1181" ? "Football" : `Sport ${selectedSportId}`

  const leagues: ParsedSport["leagues"] = []
  const sections = extractLiveTable(html)
  for (const s of sections) {
    const games: any[] = []
    for (const mb of s.matches) {
      const g = parseLiveMatchRow(mb)
      if (g) games.push({ external_id: g.external_id, home_team: g.home_team, away_team: g.away_team, start_time: g.start_time, live: g.live, markets: g.markets })
    }
    if (!games.length) continue
    const name = s.name || "Live"
    const ext = `live_${selectedSportId}_${slugify(name) || "live"}`
    leagues.push({ name, external_id: ext, games })
  }

  if (!leagues.length) return []
  return [{ key: sportKey, name: sportName, external_id: selectedSportId, leagues }]
}
