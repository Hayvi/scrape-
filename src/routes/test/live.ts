import type { Env } from "../../env"
import { getLiveHTML, getTextWithDdosBypass, getTextWithDdosBypassDetailed } from "../../fetcher"
import { json } from "../../http/response"
import { capMarkets, extractCandidatesFromJs, extractMatchIdsFromText, extractScriptSrcs, extractWidgetLiveMatches, snippetAround, uniqLimit } from "../../http/utils"
import { parseLive, parseMatchOddsGrouped } from "../../parser"
import { persistParsed } from "../../service"

export async function handleTestLiveRoute(_request: Request, env: Env, url: URL, p: string): Promise<Response | null> {
  if (p !== "/api/test/live") return null

  const persist = url.searchParams.get("persist") === "1"
  const debug = url.searchParams.get("debug") === "1"
  const deep = url.searchParams.get("deep") === "1"
  const discover = url.searchParams.get("discover") === "1"
  const limit = Math.max(1, Math.min(25, Number(url.searchParams.get("limit") ?? "10") || 10))
  try {
    const html = await getLiveHTML()
    let parsed = parseLive(html)

    let fallbackUsed: string | null = null
    let widgetMatchIds: string[] = []
    if (!parsed.length) {
      const widgetMatches = extractWidgetLiveMatches(html, limit)
      widgetMatchIds = widgetMatches.map(w => w.id)
      if (widgetMatches.length) {
        fallbackUsed = deep ? "widgets+matchOdds" : "widgets"
        const sport = { key: "football", name: "Football", external_id: "1181" }
        const games: any[] = []
        for (const wm of widgetMatches) {
          let markets: any[] = []
          if (deep) {
            try {
              const fetched = await getTextWithDdosBypassDetailed(`https://tounesbet.com/Match/MatchOddsGrouped?matchId=${encodeURIComponent(wm.id)}`, {
                accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "accept-language": "en-US,en;q=0.9",
                "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
                "x-requested-with": "XMLHttpRequest"
              })
              if (fetched.status >= 200 && fetched.status < 300) {
                markets = capMarkets(parseMatchOddsGrouped(fetched.text, wm.id))
              }
            } catch {
              markets = []
            }
          }
          games.push({
            external_id: wm.id,
            home_team: wm.home ?? "Home",
            away_team: wm.away ?? "Away",
            start_time: new Date().toISOString(),
            live: true,
            markets
          })
        }
        parsed = [{ ...sport, leagues: [{ name: "Live", external_id: "live_widgets", games }] }]
      }
    }

    if (!parsed.length) {
      try {
        const topHtml = await getTextWithDdosBypass("https://tounesbet.com/Match/TopMatches", {
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
          "x-requested-with": "XMLHttpRequest"
        })
        const ids = extractMatchIdsFromText(topHtml, limit)
        if (ids.length) {
          fallbackUsed = deep ? "topmatches+matchOdds" : "topmatches"
          const sport = { key: "football", name: "Football", external_id: "1181" }
          const games: any[] = []
          const deepLimit = deep ? Math.min(ids.length, Math.min(limit, 3)) : 0
          for (let i = 0; i < ids.length; i++) {
            const id = ids[i]
            let markets: any[] = []
            if (deep && i < deepLimit) {
              try {
                const fetched = await getTextWithDdosBypassDetailed(`https://tounesbet.com/Match/MatchOddsGrouped?matchId=${encodeURIComponent(id)}`, {
                  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                  "accept-language": "en-US,en;q=0.9",
                  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
                  "x-requested-with": "XMLHttpRequest"
                })
                if (fetched.status >= 200 && fetched.status < 300) {
                  markets = capMarkets(parseMatchOddsGrouped(fetched.text, id))
                }
              } catch {
                markets = []
              }
            }
            games.push({
              external_id: id,
              home_team: "Home",
              away_team: "Away",
              start_time: new Date().toISOString(),
              live: true,
              markets
            })
          }
          parsed = [{ ...sport, leagues: [{ name: "Top Matches", external_id: "live_topmatches", games }] }]
        }
      } catch {
      }
    }

    let persisted = false
    let persistResult: any = null
    if (persist) {
      persistResult = await persistParsed(env as any, parsed)
      persisted = true
    }
    const leagueCount = parsed.reduce((acc, s) => acc + s.leagues.length, 0)
    const gameCount = parsed.reduce((acc, s) => acc + s.leagues.reduce((a, l) => a + l.games.length, 0), 0)
    const marketCount = parsed.reduce((acc, s) => acc + s.leagues.reduce((a, l) => a + l.games.reduce((b, g) => b + g.markets.length, 0), 0), 0)
    const outcomeCount = parsed.reduce((acc, s) => acc + s.leagues.reduce((a, l) => a + l.games.reduce((b, g) => b + g.markets.reduce((c, m) => c + m.outcomes.length, 0), 0), 0), 0)

    if (debug) {
      const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() ?? null
      const snippetRaw = html.slice(0, 1200)
      const snippet = snippetRaw.replace(/\s+/g, " ").trim()

      const matchidAll = html.match(/data-matchid=["']\d+["']/gi) ?? []
      const widgetCurrentSnippet = snippetAround(html, "current_live_widget", 1200)
      const widgetUpcomingSnippet = snippetAround(html, "upcoming_live_widget", 1200)
      const scriptSrcs = extractScriptSrcs(html)

      let discovered: any = null
      if (discover) {
        const base = "https://tounesbet.com"
        const perScript: any[] = []
        const wsAll: string[] = []
        const httpAll: string[] = []
        const pathsAll: string[] = []
        const tokensAll: string[] = []

        const prioritized = uniqLimit(
          [
            ...scriptSrcs.filter(s => /flashbet-websocketlibs|flashbet-socketprotocol|transport|flashbet-libs/i.test(s)),
            ...scriptSrcs
          ],
          6
        )

        for (const src of prioritized) {
          const full = src.startsWith("http") ? src : `${base}${src}`
          try {
            const js = await getTextWithDdosBypass(full, {
              accept: "text/javascript,application/javascript,*/*;q=0.1",
              "accept-language": "en-US,en;q=0.9",
              "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
            })
            const c = extractCandidatesFromJs(js)
            perScript.push({ src, ws: c.ws.slice(0, 10), http: c.http.slice(0, 10), paths: c.paths.slice(0, 20), tokens: c.tokens.slice(0, 15) })
            wsAll.push(...c.ws)
            httpAll.push(...c.http)
            pathsAll.push(...c.paths)
            tokensAll.push(...c.tokens)
          } catch (e) {
            perScript.push({ src, error: String(e) })
          }
        }

        discovered = {
          ws: uniqLimit(wsAll, 80),
          http: uniqLimit(httpAll, 80),
          paths: uniqLimit(pathsAll, 120),
          tokens: uniqLimit(tokensAll, 120),
          perScript
        }

        const probes = [
          "/Match/TopMatches",
          "/Match/NextMatches",
          "/Match/LiveHighlightsMainWidget",
          "/Match/PopularMatches?SportId=1181&DateDay=all_days&BetRangeFilter=0"
        ]

        const probeResults: any[] = []
        for (const path of probes) {
          const full = `${base}${path}`
          try {
            const body = await getTextWithDdosBypass(full, {
              accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              "accept-language": "en-US,en;q=0.9",
              "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
            })
            const matchIds = extractMatchIdsFromText(body, 25)
            probeResults.push({ path, length: body.length, matchIds: matchIds.slice(0, 10), matchIdCount: matchIds.length })
          } catch (e) {
            probeResults.push({ path, error: String(e) })
          }
        }

        discovered.probes = probeResults
      }

      const debugInfo = {
        htmlLength: html.length,
        title,
        found: {
          main_nav: /<nav[^>]*id=["']main_nav["']/i.test(html),
          live_matches_table: /<table[^>]*id=["']live_matches_table["']/i.test(html),
          current_live_widget: /id=["']current_live_widget["']/i.test(html),
          upcoming_live_widget: /id=["']upcoming_live_widget["']/i.test(html)
        },
        hints: {
          cloudflare: /cloudflare|attention required|cf-ray|checking your browser/i.test(html),
          captcha: /captcha|recaptcha|hcaptcha/i.test(html),
          ddosGate: /document\.cookie\s*=\s*"[^";=]+=[^;]+\s*;\s*path=\//i.test(html)
        },
        dataMatchid: {
          count: matchidAll.length,
          sample: matchidAll.slice(0, 5)
        },
        widgetMatchIds,
        widgetSnippets: {
          current: widgetCurrentSnippet,
          upcoming: widgetUpcomingSnippet
        },
        scriptSrcs,
        discovered,
        snippet
      }
      return json({ persisted, persistResult, fallbackUsed, counts: { sports: parsed.length, leagues: leagueCount, games: gameCount, markets: marketCount, outcomes: outcomeCount }, debug: debugInfo, parsed })
    }

    return json({ persisted, persistResult, fallbackUsed, counts: { sports: parsed.length, leagues: leagueCount, games: gameCount, markets: marketCount, outcomes: outcomeCount }, parsed })
  } catch (e) {
    return json({ error: String(e) }, 500)
  }
}
