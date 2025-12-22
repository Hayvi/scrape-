import { ParsedSport } from "../domain"
import { decodeEntities, extractAttr, getSelectedSportIdFromNav, parseDecimal, slugify } from "./shared"

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

  const home_team = decodeEntities(home).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()
  const away_team = decodeEntities(away).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()
  if (!home_team || !away_team) return null

  const match_time = decodeEntities(rowHtml.match(/<label[^>]*class=["'][^"']*match_time[^"']*["'][^>]*>([\s\S]*?)<\/label>/i)?.[1] ?? "").replace(/\s+/g, " ").trim()
  const score = decodeEntities(rowHtml.match(/<div[^>]*class=["'][^"']*match_score[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? "").replace(/\s+/g, " ").trim()

  const tds: string[] = []
  const tdRe = /<td[^>]*class=["'][^"']*betColumn[^"']*main-market-no_\d+[^"']*["'][^>]*>[\s\S]*?<\/td>/gi
  let tm: RegExpExecArray | null
  while ((tm = tdRe.exec(rowHtml)) !== null) tds.push(tm[0])

  const markets: import("../domain").ParsedMarket[] = []
  const nowIso = new Date().toISOString()

  if (tds[0]) {
    const spans = parseMatchOddsFromColumn(tds[0])
    const labels = ["1", "X", "2"]
    const outcomes: import("../domain").ParsedOutcome[] = []
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
    const outcomes: import("../domain").ParsedOutcome[] = []
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
    const outcomes: import("../domain").ParsedOutcome[] = []
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
    const outcomes: import("../domain").ParsedOutcome[] = []
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
    home_team,
    away_team,
    start_time: nowIso,
    live: true,
    markets,
    extra: { match_time, score }
  }
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
