import { getLiveHTML, getNextMatchesHTML, getPopularMatchesHTML, getSportHTML, getTextWithDdosBypassDetailed } from "./fetcher"
import { getSelectedSportIdFromNav, parseLive, parseMatchOddsGrouped, parsePopularMatchesFragment, parsePrematch, parsePrematchNextMatches } from "./parser"
import { Game, League, Market, Outcome, ParsedSport, Sport } from "./domain"
import { getClient, getGamesIdMap, getLeaguesIdMap, getMarketsIdMap, getSportsIdMap, upsertGames, upsertLeagues, upsertMarkets, upsertOutcomes, upsertSports } from "./db"

type WorkerEnv = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string; DEFAULT_SPORT_ID?: string }

const SOURCE = "tounesbet"

function capMarkets(markets: any[], maxMarkets = 60, maxOutcomes = 16) {
  const ms = markets.slice(0, maxMarkets)
  for (const m of ms) {
    if (Array.isArray(m?.outcomes)) m.outcomes = m.outcomes.slice(0, maxOutcomes)
  }
  return ms
}

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

  const outcomeToMarketExt = new Map<string, string>()
  for (const ps of parsed) {
    for (const pl of ps.leagues) {
      for (const pg of pl.games) {
        for (const pm of pg.markets) {
          for (const po of pm.outcomes) {
            if (!outcomeToMarketExt.has(po.external_id)) outcomeToMarketExt.set(po.external_id, pm.external_id)
          }
        }
      }
    }
  }

  for (let i = 0; i < outcomes.length; i++) {
    const mExt = outcomeToMarketExt.get(outcomes[i].external_id)
    if (mExt && marketIdMap[mExt]) outcomes[i].market_id = marketIdMap[mExt]
  }
  const outcomesWithMarket = outcomes.filter(o => typeof o.market_id === "number")
  const outcomesDeduped = uniqBy(outcomesWithMarket, o => [o.market_id, o.label, o.handicap])
  await upsertOutcomes(db, outcomesDeduped)

  return { games: games.length }
}

export async function runPrematch(env: WorkerEnv) {
  const sportId = env.DEFAULT_SPORT_ID || "1181"
  let navHtml: string
  try {
    navHtml = await getSportHTML(sportId)
  } catch {
    navHtml = await getNextMatchesHTML(sportId)
  }
  const selected = getSelectedSportIdFromNav(navHtml) || sportId

  const nextHtml = await getNextMatchesHTML(selected)
  const parsed = parsePrematchNextMatches(nextHtml, selected)

  const games = parsed.flatMap(s => s.leagues).flatMap(l => l.games)
  const maxDeepGames = Math.min(12, games.length)
  for (let i = 0; i < maxDeepGames; i++) {
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
