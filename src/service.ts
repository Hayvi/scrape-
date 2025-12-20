import { getPrematchHTML, getLiveHTML, getPopularMatchesHTML, getSportHTML } from "./fetcher"
import { parsePrematch, parseLive, parsePopularMatchesFragment, getSelectedSportIdFromNav } from "./parser"
import { Game, League, Market, Outcome, ParsedSport, Sport } from "./domain"
import { getClient, getGamesIdMap, getLeaguesIdMap, getMarketsIdMap, getSportsIdMap, upsertGames, upsertLeagues, upsertMarkets, upsertOutcomes, upsertSports } from "./db"

type WorkerEnv = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string; DEFAULT_SPORT_ID?: string }

const SOURCE = "tounesbet"

function uniqBy<T, K>(arr: T[], key: (v: T) => K): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const v of arr) {
    const k = JSON.stringify(key(v))
    if (seen.has(k)) continue
    seen.add(k)
    out.push(v)
  }
  return out
}

function mapParsed(parsed: ParsedSport[]): { sports: Sport[]; leagues: League[]; games: Game[]; markets: Market[]; outcomes: Outcome[] } {
  const sports: Sport[] = []
  const leagues: League[] = []
  const games: Game[] = []
  const markets: Market[] = []
  const outcomes: Outcome[] = []

  for (const s of parsed) {
    sports.push({ source: SOURCE, external_id: s.external_id, key: s.key, name: s.name })
    for (const l of s.leagues) {
      leagues.push({ source: SOURCE, external_id: l.external_id, name: l.name })
      for (const g of l.games) {
        games.push({ source: SOURCE, external_id: g.external_id, home_team: g.home_team, away_team: g.away_team, start_time: new Date(g.start_time).toISOString(), live: g.live })
        for (const m of g.markets) {
          markets.push({ source: SOURCE, external_id: m.external_id, key: m.key, name: m.name })
          for (const o of m.outcomes) {
            outcomes.push({ source: SOURCE, external_id: o.external_id, label: o.label, price: o.price, handicap: o.handicap })
          }
        }
      }
    }
  }

  return { sports: uniqBy(sports, x => [x.source, x.external_id]), leagues: uniqBy(leagues, x => [x.source, x.external_id]), games: uniqBy(games, x => [x.source, x.external_id]), markets: uniqBy(markets, x => [x.source, x.external_id]), outcomes }
}

export async function persistParsed(env: WorkerEnv, parsed: ParsedSport[]): Promise<{ games: number }> {
  const db = getClient(env)
  const { sports, leagues, games, markets, outcomes } = mapParsed(parsed)

  await upsertSports(db, sports)
  const sportIdMap = await getSportsIdMap(db, SOURCE, sports.map(s => s.external_id))

  for (let i = 0; i < leagues.length; i++) {
    const sExt = parsed.find(ps => ps.leagues.some(pl => pl.external_id === leagues[i].external_id))?.external_id
    if (sExt && sportIdMap[sExt]) leagues[i].sport_id = sportIdMap[sExt]
  }
  await upsertLeagues(db, leagues)
  const leagueIdMap = await getLeaguesIdMap(db, SOURCE, leagues.map(l => l.external_id))

  for (let i = 0; i < games.length; i++) {
    const lExt = parsed.flatMap(ps => ps.leagues).find(pl => pl.games.some(pg => pg.external_id === games[i].external_id))?.external_id
    if (lExt && leagueIdMap[lExt]) games[i].league_id = leagueIdMap[lExt]
  }
  await upsertGames(db, games)
  const gameIdMap = await getGamesIdMap(db, SOURCE, games.map(g => g.external_id))

  for (let i = 0; i < markets.length; i++) {
    const gExt = parsed.flatMap(ps => ps.leagues).flatMap(pl => pl.games).find(pg => pg.markets.some(pm => pm.external_id === markets[i].external_id))?.external_id
    if (gExt && gameIdMap[gExt]) markets[i].game_id = gameIdMap[gExt]
  }
  await upsertMarkets(db, markets)
  const marketIdMap = await getMarketsIdMap(db, SOURCE, markets.map(m => m.external_id))

  for (let i = 0; i < outcomes.length; i++) {
    const mExt = parsed.flatMap(ps => ps.leagues).flatMap(pl => pl.games).flatMap(pg => pg.markets).find(pm => pm.outcomes.some(po => po.external_id === outcomes[i].external_id))?.external_id
    if (mExt && marketIdMap[mExt]) outcomes[i].market_id = marketIdMap[mExt]
  }
  await upsertOutcomes(db, outcomes)

  return { games: games.length }
}

export async function runPrematch(env: WorkerEnv) {
  // Prefer explicit sport page if DEFAULT_SPORT_ID provided, else fall back to Prematch
  const sportId = env.DEFAULT_SPORT_ID || "1181"
  let html: string
  try {
    html = await getSportHTML(sportId)
  } catch {
    html = await getPrematchHTML()
  }
  const parsed = parsePrematch(html)

  // Determine selected sport and attach Popular Matches league if available
  const selected = getSelectedSportIdFromNav(html) || sportId
  try {
    const popHtml = await getPopularMatchesHTML(selected, "all_days", "0")
    const league = parsePopularMatchesFragment(popHtml, selected)
    if (league) {
      const target = parsed.find(s => s.external_id === selected)
      if (target) target.leagues.push(league)
    }
  } catch (e) {
    console.error("PopularMatches fetch/parse failed", String(e))
  }

  const res = await persistParsed(env, parsed)
  return res
}

export async function runLive(env: WorkerEnv) {
  const html = await getLiveHTML()
  const parsed = parseLive(html)
  const res = await persistParsed(env, parsed)
  return res
}
