import { getNextMatchesHTML, getPopularMatchesHTML, getSportHTML, getTextWithDdosBypassDetailed } from "../fetcher"
import { getSelectedSportIdFromNav, parseMatchOddsGrouped, parsePopularMatchesFragment, parsePrematchNextMatches } from "../parser"
import { persistParsed } from "./persist"

type WorkerEnv = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string; DEFAULT_SPORT_ID?: string }

function capMarkets(markets: any[], maxMarkets = 60, maxOutcomes = 16) {
  const ms = markets.slice(0, maxMarkets)
  for (const m of ms) {
    if (Array.isArray(m?.outcomes)) m.outcomes = m.outcomes.slice(0, maxOutcomes)
  }
  return ms
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
