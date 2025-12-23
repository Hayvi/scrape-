import { ParsedLeague, ParsedSport } from "../domain"
import { decodeEntities, extractAttr, parseDecimal, slugify } from "./shared"

const TUNIS_TZ = "Africa/Tunis"

function tzOffsetMs(timeZone: string, utcMs: number): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
  const parts = dtf.formatToParts(new Date(utcMs))
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0")
  const y = get("year")
  const m = get("month")
  const d = get("day")
  const hh = get("hour")
  const mm = get("minute")
  const ss = get("second")
  const asUtc = Date.UTC(y, m - 1, d, hh, mm, ss)
  return asUtc - utcMs
}

function tunisLocalToIso(dateDdMmYyyy: string, timeHhMmSs: string): string {
  const [dd, mm, yyyy] = String(dateDdMmYyyy).split("/")
  if (!dd || !mm || !yyyy) return new Date().toISOString()
  const t = String(timeHhMmSs)
  const base = t.length === 5 ? `${t}:00` : t
  const m = base.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/)
  if (!m) return new Date().toISOString()
  const hh = Number(m[1])
  const mi = Number(m[2])
  const ss = Number(m[3] ?? "0")
  const y = Number(yyyy)
  const mo = Number(mm)
  const da = Number(dd)
  if (![hh, mi, ss, y, mo, da].every(Number.isFinite)) return new Date().toISOString()

  const localAsUtc = Date.UTC(y, mo - 1, da, hh, mi, ss)
  const utc1 = localAsUtc - tzOffsetMs(TUNIS_TZ, localAsUtc)
  const utc2 = localAsUtc - tzOffsetMs(TUNIS_TZ, utc1)
  return new Date(utc2).toISOString()
}

function extractSportsFromNav(html: string): ParsedSport[] {
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

function extractPopularMatches(html: string) {
  const out: { home: string; away: string; start: string; outcomes: { id: string; label: string; price: number }[] }[] = []
  const containerMatch = html.match(/<div[^>]*class=["'][^"']*popular_matches_slider[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)
  const scope = containerMatch ? containerMatch[1] : html
  const starts: number[] = []
  const blocks: string[] = []
  const re = /class=["'][^"']*popular-slider-item[^"']*["'][^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(scope)) !== null) starts.push(m.index)
  if (!starts.length) return out
  starts.push(scope.length)
  for (let i = 0; i < starts.length - 1; i++) blocks.push(scope.slice(starts[i], starts[i + 1]))

  for (const b of blocks) {
    const teamRe = /<(?:div|span)[^>]*style=["'][^"']*text-transform:\s*uppercase[^"']*["'][^>]*>([^<]+)<\/(?:div|span)>/gi
    const teams: string[] = []
    let tm: RegExpExecArray | null
    while ((tm = teamRe.exec(b)) !== null) {
      const t = decodeEntities(tm[1]).trim()
      if (t) teams.push(t)
      if (teams.length === 2) break
    }
    if (teams.length < 2) continue

    const dateM = b.match(/>(\d{2}\/\d{2}\/\d{4})</)
    const timeM = b.match(/>(\d{2}:\d{2}:\d{2})</)
    let startIso = new Date().toISOString()
    if (dateM && timeM) {
      startIso = tunisLocalToIso(dateM[1], timeM[1])
    }

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

function parseNextMatchesStartTime(rowHtml: string): string {
  const dateM = rowHtml.match(/>(\d{2}\/\d{2}\/\d{4})</)
  const timeM = rowHtml.match(/>(\d{2}:\d{2}:\d{2})</) ?? rowHtml.match(/>(\d{2}:\d{2})</)
  if (dateM && timeM) {
    return tunisLocalToIso(dateM[1], timeM[1])
  }
  return new Date().toISOString()
}

function parseNextMatchesTeams(rowHtml: string): { home: string; away: string } | null {
  const home1 = rowHtml.match(/<div[^>]*class=["'][^"']*(competitor1-name|team1|home)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[2]
  const away1 = rowHtml.match(/<div[^>]*class=["'][^"']*(competitor2-name|team2|away)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[2]
  if (home1 && away1) {
    return { home: decodeEntities(home1).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(), away: decodeEntities(away1).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() }
  }

  const text = decodeEntities(rowHtml.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim()
  const m = text.match(/(.+?)\s+-\s+(.+?)(?:\s{2,}|$)/)
  if (m) return { home: m[1].trim(), away: m[2].trim() }
  return null
}

function extractNextMatchesSections(html: string) {
  const scope = html
  const sections: { tournamentId: string | null; name: string; rows: string[] }[] = []

  const headerRe = /<tr[^>]*class=["'][^"']*header_tournament_row[^"']*["'][^>]*>[\s\S]*?<\/tr>/gi
  const indices: { idx: number; name: string; tournamentId: string | null }[] = []
  let hm: RegExpExecArray | null
  while ((hm = headerRe.exec(scope)) !== null) {
    const td = hm[0].match(/<td[^>]*class=["']tournament_name_section["'][^>]*>([\s\S]*?)<\/td>/i)?.[1] ?? ""
    const name = decodeEntities(td.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim() || "Tournament"
    const tournamentId = hm[0].match(/data-tournamentid=["'](\d+)["']/i)?.[1] ?? null
    indices.push({ idx: hm.index, name, tournamentId })
  }
  if (!indices.length) return sections
  indices.push({ idx: scope.length, name: "", tournamentId: null })

  for (let i = 0; i < indices.length - 1; i++) {
    const start = indices[i].idx
    const end = indices[i + 1].idx
    const block = scope.slice(start, end)
    const matchBlocks: string[] = []
    const matchRe = /<tr[^>]*class=["'][^"']*trMatch[^"']*live_match_data[^"']*["'][^>]*data-matchid=["'](\d+)["'][\s\S]*?<\/tr>/gi
    let mm: RegExpExecArray | null
    while ((mm = matchRe.exec(block)) !== null) matchBlocks.push(mm[0])
    if (matchBlocks.length) sections.push({ tournamentId: indices[i].tournamentId, name: indices[i].name, rows: matchBlocks })
  }
  return sections
}

export function parsePrematch(html: string): ParsedSport[] {
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

export function parsePrematchNextMatches(html: string, sportId: string): ParsedSport[] {
  const sportKey = sportId === "1181" ? "football" : `sport-${sportId}`
  const sportName = sportId === "1181" ? "Football" : `Sport ${sportId}`

  const leagues: ParsedSport["leagues"] = []
  const sections = extractNextMatchesSections(html)
  for (const s of sections) {
    const games: any[] = []
    for (const row of s.rows) {
      const matchId = row.match(/data-matchid=["'](\d+)["']/i)?.[1] ?? null
      if (!matchId) continue
      const teams = parseNextMatchesTeams(row)
      if (!teams) continue
      games.push({
        external_id: matchId,
        home_team: teams.home,
        away_team: teams.away,
        start_time: parseNextMatchesStartTime(row),
        live: false,
        markets: []
      })
    }
    if (!games.length) continue
    const ext = `prematch_${sportId}_${slugify(s.name) || "tournament"}`
    leagues.push({ name: s.name, external_id: ext, games })
  }

  if (!leagues.length) return []
  return [{ key: sportKey, name: sportName, external_id: sportId, leagues }]
}

function parseMatchListTeams(rowHtml: string): { home: string; away: string } | null {
  const home1 = rowHtml.match(/<div[^>]*class=["'][^"']*competitor1-name[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1]
  const away1 = rowHtml.match(/<div[^>]*class=["'][^"']*competitor2-name[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1]
  if (home1 && away1) {
    const home = decodeEntities(home1).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()
    const away = decodeEntities(away1).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()
    if (home && away) return { home, away }
  }

  const home2 = rowHtml.match(/<(?:div|span)[^>]*class=["'][^"']*(competitor1-name|team1|home)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|span)>/i)?.[2]
  const away2 = rowHtml.match(/<(?:div|span)[^>]*class=["'][^"']*(competitor2-name|team2|away)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|span)>/i)?.[2]
  if (home2 && away2) {
    const home = decodeEntities(home2).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()
    const away = decodeEntities(away2).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()
    if (home && away) return { home, away }
  }

  const text = decodeEntities(rowHtml.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim()
  const m = text.match(/(.+?)\s+-\s+(.+?)(?:\s{2,}|$)/)
  if (m) return { home: m[1].trim(), away: m[2].trim() }
  return null
}

function parseMatchListStartIso(dateDdMmYyyy: string | null, rowHtml: string): string {
  const rowDate = rowHtml.match(/(\d{2}\/\d{2}\/\d{4})/)?.[1] ?? null
  const usedDate = dateDdMmYyyy ?? rowDate
  const timeM = rowHtml.match(/>\s*(\d{2}:\d{2})(?::\d{2})?\s*</)
  if (usedDate && timeM) {
    return tunisLocalToIso(usedDate, timeM[1])
  }
  return new Date().toISOString()
}

function parseMatchList1x2Market(rowHtml: string, matchId: string) {
  const cell = rowHtml.match(/<td[^>]*class=["'][^"']*betColumn[^"']*main-market-no_1[^"']*["'][^>]*>([\s\S]*?)<\/td>/i)?.[1] ?? null
  if (!cell) return null

  const odds: { id: string; price: number }[] = []
  const tagRe = /<(div|span)[^>]*data-matchoddid=["'](\d+)["'][^>]*>/gi
  let tm: RegExpExecArray | null
  while ((tm = tagRe.exec(cell)) !== null) {
    const openTag = tm[0]
    if (!/class=["'][^"']*(match-odd|match_odd)[^"']*["']/i.test(openTag)) continue
    const id = tm[2]
    const raw = extractAttr(openTag, "data-oddvaluedecimal")
    if (!raw) continue
    const price = parseDecimal(raw)
    if (!Number.isFinite(price) || price <= 0) continue
    odds.push({ id, price })
    if (odds.length >= 3) break
  }

  if (odds.length < 3) return null
  const o1 = odds[0]
  const ox = odds[1]
  const o2 = odds[2]

  return {
    key: "1x2",
    name: "1X2",
    external_id: `${matchId}_1x2`,
    outcomes: [
      { label: "1", price: o1.price, handicap: null, external_id: `${matchId}_${o1.id}` },
      { label: "X", price: ox.price, handicap: null, external_id: `${matchId}_${ox.id}` },
      { label: "2", price: o2.price, handicap: null, external_id: `${matchId}_${o2.id}` },
    ]
  }
}

function extractMatchListSections(html: string) {
  const scope = html
  const sections: { tournamentId: string | null; name: string; rows: { html: string; date: string | null }[] }[] = []

  const headerRe = /<tr[^>]*class=["'][^"']*header_tournament_row[^"']*["'][^>]*>[\s\S]*?<\/tr>/gi
  const indices: { idx: number; block: string }[] = []
  let hm: RegExpExecArray | null
  while ((hm = headerRe.exec(scope)) !== null) indices.push({ idx: hm.index, block: hm[0] })
  if (!indices.length) return sections
  indices.push({ idx: scope.length, block: "" })

  for (let i = 0; i < indices.length - 1; i++) {
    const headerHtml = indices[i].block
    const tournamentId = headerHtml.match(/data-tournamentid=["'](\d+)["']/i)?.[1] ?? null
    const nameM = headerHtml.match(/<div[^>]*class=["']category-tournament-title["'][^>]*>([\s\S]*?)<\/div>/i)?.[1]
    const name = decodeEntities(String(nameM ?? "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim() || "Tournament"

    const block = scope.slice(indices[i].idx, indices[i + 1].idx)

    const rows: { html: string; date: string | null }[] = []
    const trRe = /<tr[^>]*>[\s\S]*?<\/tr>/gi
    let rm: RegExpExecArray | null
    let currentDate: string | null = null
    while ((rm = trRe.exec(block)) !== null) {
      const tr = rm[0]
      const hasMatch = /data-matchid=["'](\d+)["']/i.test(tr)
      const dateM = tr.match(/(\d{2}\/\d{2}\/\d{4})/)
      if (!hasMatch && dateM) {
        currentDate = dateM[1]
        continue
      }
      if (hasMatch) rows.push({ html: tr, date: currentDate })
    }

    if (rows.length) sections.push({ tournamentId, name, rows })
  }
  return sections
}

export function parsePrematchSportMatchList(html: string, sportId: string): ParsedSport[] {
  const sportKey = sportId === "1181" ? "football" : `sport-${sportId}`
  const sportName = sportId === "1181" ? "Football" : `Sport ${sportId}`

  const leagues: ParsedSport["leagues"] = []
  const sections = extractMatchListSections(html)
  for (const s of sections) {
    const games: any[] = []
    for (const entry of s.rows) {
      const row = entry.html
      const matchId = row.match(/data-matchid=["'](\d+)["']/i)?.[1] ?? null
      if (!matchId) continue
      const teams = parseMatchListTeams(row)
      if (!teams) continue
      const oneX2 = parseMatchList1x2Market(row, matchId)
      games.push({
        external_id: matchId,
        home_team: teams.home,
        away_team: teams.away,
        start_time: parseMatchListStartIso(entry.date, row),
        live: false,
        markets: oneX2 ? [oneX2] : []
      })
    }
    if (!games.length) continue
    const ext = `prematch_${sportId}_${s.tournamentId ?? (slugify(s.name) || "tournament")}`
    leagues.push({ name: s.name, external_id: ext, games })
  }

  if (!leagues.length) return []
  return [{ key: sportKey, name: sportName, external_id: sportId, leagues }]
}
