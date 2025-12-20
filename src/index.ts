import { persistParsed, runLive, runPrematch } from "./service"
import { getLiveHTML, getNextMatchesHTML, getTextWithDdosBypass, getTextWithDdosBypassDetailed } from "./fetcher"
import { parseLive, parseMatchOddsGrouped, parsePrematchNextMatches } from "./parser"
import { getClient, upsertLiveMeta } from "./db"
import { getStatscoreSSR, parseStatscoreSSR } from "./statscore"
import type { ExecutionContext, ScheduledEvent } from "@cloudflare/workers-types"

export interface Env {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
  DEFAULT_SPORT_ID?: string
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } })
}

function notFound(msg = "Not Found") { return json({ error: msg }, 404) }

function safeBool(v: unknown) {
  return !!(v && String(v).trim().length)
}

function extractWidgetLiveMatches(html: string, limit: number) {
  const out: { id: string; home: string | null; away: string | null }[] = []
  const seen = new Set<string>()

  const widgetIds = ["current_live_widget", "upcoming_live_widget"]
  for (const wid of widgetIds) {
    const idx = html.toLowerCase().indexOf(wid)
    if (idx < 0) continue
    const window = html.slice(idx, idx + 30000)
    const idRe = /data-matchid=["'](\d+)["']/gi
    let m: RegExpExecArray | null
    while ((m = idRe.exec(window)) !== null) {
      const id = m[1]
      if (!id || seen.has(id)) continue
      out.push({ id, home: null, away: null })
      seen.add(id)
      if (out.length >= limit) return out
    }
  }
  return out
}

function capMarkets(markets: any[], maxMarkets = 40, maxOutcomes = 12) {
  const ms = markets.slice(0, maxMarkets)
  for (const m of ms) {
    if (Array.isArray(m?.outcomes)) m.outcomes = m.outcomes.slice(0, maxOutcomes)
  }
  return ms
}

function snippetAround(haystack: string, needle: string, radius: number) {
  const idx = haystack.toLowerCase().indexOf(needle.toLowerCase())
  if (idx < 0) return null
  const start = Math.max(0, idx - radius)
  const end = Math.min(haystack.length, idx + radius)
  return haystack.slice(start, end).replace(/\s+/g, " ").trim()
}

function extractScriptSrcs(html: string, max = 12) {
  const out: string[] = []
  const re = /<script[^>]*\ssrc=["']([^"']+)["'][^>]*>\s*<\/script>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    out.push(m[1])
    if (out.length >= max) break
  }
  return out
}

function uniqLimit(values: string[], max: number) {
  const out: string[] = []
  const seen = new Set<string>()
  for (const v of values) {
    if (seen.has(v)) continue
    seen.add(v)
    out.push(v)
    if (out.length >= max) break
  }
  return out
}

function extractCandidatesFromJs(js: string) {
  const ws = uniqLimit(js.match(/wss?:\/\/[^\s"'<>\\)]+/gi) ?? [], 50)
  const http = uniqLimit(js.match(/https?:\/\/[^\s"'<>\\)]+/gi) ?? [], 50)
  const pathsRaw = js.match(/\/[A-Za-z0-9][A-Za-z0-9\/._-]{2,}/g) ?? []
  const paths = uniqLimit(
    pathsRaw.filter(p => /live|match|odd|websocket|socket|signalr|transport|api/i.test(p)),
    80
  )

  const tokensRaw = js.match(/(?:negotiate|connect|start|hub|signalr|websocket)[^\n\r]{0,120}/gi) ?? []
  const tokens = uniqLimit(tokensRaw.map(t => t.replace(/\s+/g, " ").trim()), 80)

  return { ws, http, paths, tokens }
}

function extractMatchIdsFromText(text: string, limit = 25) {
  const ids: string[] = []
  const seen = new Set<string>()
  const reList: RegExp[] = [
    /data-matchid=["'](\d+)["']/gi,
    /matchId=(\d+)/gi,
    /liveMatchId=(\d+)/gi,
    /\bLiveMatchId\b[^0-9]{0,15}(\d{4,})/g,
    /\bMatchId\b[^0-9]{0,15}(\d{4,})/g
  ]
  for (const re of reList) {
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const id = m[1]
      if (!id || seen.has(id)) continue
      seen.add(id)
      ids.push(id)
      if (ids.length >= limit) return ids
    }
  }
  return ids
}

async function serveOdds(env: Env, sportKey: string, live: boolean) {
  const db = getClient(env)
  const source = "tounesbet"
  const s = await db.from("sports").select("id,key,name").eq("source", source).eq("key", sportKey).maybeSingle()
  if (!s.data) return notFound("sport")
  const sportId = s.data.id
  const leagues = await db.from("leagues").select("id,name").eq("sport_id", sportId)
  const leaguesData = (leagues.data ?? []) as { id: number; name: string }[]
  const leagueIds = leaguesData.map((l) => l.id)
  if (!leagueIds.length) return json({ sport: { key: s.data.key, name: s.data.name }, leagues: [] })
  const games = await db.from("games").select("id,external_id,league_id,home_team,away_team,start_time,live").in("league_id", leagueIds).eq("live", live)
  const gamesData = (games.data ?? []) as { id: number; external_id: string; league_id: number; home_team: string; away_team: string; start_time: string; live: boolean }[]
  const gameIds = gamesData.map((g) => g.id)

  const liveMetaByLsId = new Map<string, any>()
  if (live) {
    const lsIds = gamesData.map(g => g.external_id).filter(Boolean)
    if (lsIds.length) {
      const metaRes = await db
        .from("live_meta")
        .select("provider_ls_id,provider_event_id,status_name,clock_time,start_time,home_team,away_team,home_score,away_score,competition_name")
        .eq("provider", "statscore")
        .in("provider_ls_id", lsIds)
      for (const m of metaRes.data ?? []) {
        if (m.provider_ls_id) liveMetaByLsId.set(m.provider_ls_id, m)
      }
    }
  }

  const markets = gameIds.length ? await db.from("markets").select("id,game_id,key,name").in("game_id", gameIds) : { data: [] as any[] }
  const marketsData = (markets.data ?? []) as { id: number; game_id: number; key: string; name: string }[]
  const marketIds = marketsData.map((m) => m.id)
  const outcomes = marketIds.length ? await db.from("outcomes").select("id,market_id,label,price,handicap").in("market_id", marketIds) : { data: [] as any[] }
  const outcomesData = (outcomes.data ?? []) as { id: number; market_id: number; label: string; price: number; handicap: number | null }[]

  const marketsByGame = new Map<number, { id: number; key: string; name: string; outcomes: { id: number; label: string; price: number; handicap: number | null }[] }[]>()
  for (const m of marketsData) {
    marketsByGame.set(m.game_id, [])
  }
  for (const m of marketsData) {
    const arr = marketsByGame.get(m.game_id)!
    arr.push({ id: m.id, key: m.key, name: m.name, outcomes: [] })
  }
  const marketArr = marketsData
  const marketIndex = new Map<number, number>()
  for (let i = 0; i < marketArr.length; i++) marketIndex.set(marketArr[i].id, i)

  for (const o of outcomesData) {
    const idx = marketIndex.get(o.market_id)
    if (idx !== undefined) {
      const m = marketArr[idx]
      const bucket = marketsByGame.get(m.game_id)!
      const entry = bucket.find(x => x.id === m.id)
      if (entry) entry.outcomes.push({ id: o.id, label: o.label, price: o.price, handicap: o.handicap })
    }
  }

  const gamesByLeague = new Map<number, any[]>()
  for (const l of leaguesData) gamesByLeague.set(l.id, [])
  for (const g of gamesData) {
    const meta = live ? (liveMetaByLsId.get(g.external_id) ?? null) : null
    gamesByLeague.get(g.league_id)!.push({ id: g.id, externalId: g.external_id, homeTeam: g.home_team, awayTeam: g.away_team, startTime: g.start_time, live: g.live, markets: marketsByGame.get(g.id) ?? [], liveMeta: meta })
  }

  const resp = {
    sport: { key: s.data.key, name: s.data.name },
    leagues: leaguesData.map((l) => ({ id: l.id, name: l.name, games: gamesByLeague.get(l.id) ?? [] }))
  }
  return json(resp)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const p = url.pathname
    if (request.method === "GET") {
      if (p === "/api/test/env") {
        const rawUrl = String(env.SUPABASE_URL ?? "")
        const trimmed = rawUrl.trim()
        let urlValid = false
        let urlHost: string | null = null
        let urlProtocol: string | null = null
        if (trimmed && /^https?:\/\//i.test(trimmed)) {
          try {
            const u = new URL(trimmed)
            urlValid = true
            urlHost = u.host
            urlProtocol = u.protocol
          } catch {
            urlValid = false
          }
        }
        return json({
          supabase: {
            urlPresent: safeBool(env.SUPABASE_URL),
            urlTrimmedLength: trimmed.length,
            urlValid,
            urlHost,
            urlProtocol,
            serviceRoleKeyPresent: safeBool(env.SUPABASE_SERVICE_ROLE_KEY)
          },
          worker: {
            defaultSportId: env.DEFAULT_SPORT_ID ?? null
          }
        })
      }
      if (p === "/api/test/live") {
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
              for (const p of probes) {
                const full = `${base}${p}`
                try {
                  const body = await getTextWithDdosBypass(full, {
                    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "accept-language": "en-US,en;q=0.9",
                    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
                  })
                  const matchIds = extractMatchIdsFromText(body, 25)
                  probeResults.push({ path: p, length: body.length, matchIds: matchIds.slice(0, 10), matchIdCount: matchIds.length })
                } catch (e) {
                  probeResults.push({ path: p, error: String(e) })
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

      if (p === "/api/test/prematch") {
        const persist = url.searchParams.get("persist") === "1"
        const deep = url.searchParams.get("deep") === "1"
        const limit = Math.max(1, Math.min(25, Number(url.searchParams.get("limit") ?? "10") || 10))
        try {
          const sportId = env.DEFAULT_SPORT_ID || "1181"
          const html = await getNextMatchesHTML(sportId)
          let parsed = parsePrematchNextMatches(html, sportId)

          if (deep && parsed.length) {
            const games = parsed.flatMap(s => s.leagues).flatMap(l => l.games)
            const deepLimit = Math.min(games.length, Math.min(limit, 3))
            for (let i = 0; i < deepLimit; i++) {
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
          const outcomeCount = parsed.reduce(
            (acc, s) =>
              acc +
              s.leagues.reduce(
                (a, l) =>
                  a +
                  l.games.reduce(
                    (b, g) => b + g.markets.reduce((c, m) => c + m.outcomes.length, 0),
                    0
                  ),
                0
              ),
            0
          )

          return json({ persisted, persistResult, counts: { sports: parsed.length, leagues: leagueCount, games: gameCount, markets: marketCount, outcomes: outcomeCount }, parsed })
        } catch (e) {
          return json({ error: String(e) }, 500)
        }
      }

      if (p === "/api/test/probe") {
        const rawPath = url.searchParams.get("path")
        if (!rawPath) return json({ error: "missing path" }, 400)
        const target = rawPath.startsWith("http") ? rawPath : `https://tounesbet.com${rawPath.startsWith("/") ? "" : "/"}${rawPath}`
        try {
          const res = await getTextWithDdosBypassDetailed(target, {
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "accept-language": "en-US,en;q=0.9",
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
            "x-requested-with": "XMLHttpRequest"
          })
          const ids = extractMatchIdsFromText(res.text, 50)
          const signals = {
            divOddRow: (res.text.match(/divOddRow/gi) ?? []).length,
            divOddRowTag: (res.text.match(/<div[^>]*class=["'][^"']*divOddRow[^"']*["'][^>]*>/gi) ?? []).length,
            divOddsTableTag: (res.text.match(/<div[^>]*class=["'][^"']*divOddsTable[^"']*["'][^>]*>/gi) ?? []).length,
            dataMatchOddId: (res.text.match(/data-matchoddid=/gi) ?? []).length,
            matchOddClass: (res.text.match(/class=["'][^"']*match-odd/gi) ?? []).length,
            oddName: (res.text.match(/class=["']oddName["']/gi) ?? []).length,
            oddNameTag: (res.text.match(/<div[^>]*class=["'][^"']*oddName[^"']*["'][^>]*>/gi) ?? []).length,
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
          return json({
            target,
            status: res.status,
            contentType: res.contentType,
            length: res.text.length,
            signals,
            firstOddSnippet,
            firstOddNameSnippet,
            firstDivOddsTableSnippet,
            firstRowSignals,
            matchIdCount: ids.length,
            matchIds: ids.slice(0, 25),
            snippet
          })
        } catch (e) {
          return json({ target, error: String(e) }, 500)
        }
      }
      if (p.startsWith("/api/test/statscore/")) {
        const raw = decodeURIComponent(p.slice("/api/test/statscore/".length))
        const lsId = raw.startsWith("m:") ? raw.slice(2) : raw
        const wg = url.searchParams.get("wg") ?? "65c592e745164675a446d35b"
        const tz = url.searchParams.get("tz") ?? "0"
        const persist = url.searchParams.get("persist") === "1"
        try {
          const payload = await getStatscoreSSR(lsId, wg, "en", tz)
          const meta = parseStatscoreSSR(payload, lsId)
          let persisted = false
          if (persist) {
            const db = getClient(env)
            const provider_key = `statscore:ls:${lsId}`
            await upsertLiveMeta(db, [{
              provider_key,
              provider: "statscore",
              provider_ls_id: meta.provider_ls_id,
              provider_event_id: meta.provider_event_id,
              status_name: meta.status_name,
              clock_time: meta.clock_time ?? null,
              start_time: meta.start_time ?? null,
              home_team: meta.home_team ?? null,
              away_team: meta.away_team ?? null,
              home_score: meta.home_score ?? null,
              away_score: meta.away_score ?? null,
              competition_name: meta.competition_name ?? null
            }])
            persisted = true
          }
          return json({ lsId, widgetGroup: wg, timezone: tz, meta, persisted })
        } catch (e) {
          return json({ error: String(e) }, 500)
        }
      }
      if (p.startsWith("/api/test/match/")) {
        const matchId = decodeURIComponent(p.slice("/api/test/match/".length))
        const debug = url.searchParams.get("debug") === "1"
        try {
          const target = `https://tounesbet.com/Match/MatchOddsGrouped?matchId=${encodeURIComponent(String(matchId))}`
          const fetched = await getTextWithDdosBypassDetailed(target, {
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "accept-language": "en-US,en;q=0.9",
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
            "x-requested-with": "XMLHttpRequest"
          })

          const html = fetched.text
          const markets = parseMatchOddsGrouped(html, matchId)

          if (debug) {
            const signals = {
              divOddRowTag: (html.match(/<div[^>]*class=["'][^"']*divOddRow[^"']*["'][^>]*>/gi) ?? []).length,
              oddNameTag: (html.match(/<div[^>]*class=["'][^"']*oddName[^"']*["'][^>]*>/gi) ?? []).length,
              dataMatchOddId: (html.match(/data-matchoddid=/gi) ?? []).length,
              matchOddClass: (html.match(/class=["'][^"']*match-odd/gi) ?? []).length,
              quoteValue: (html.match(/class=["']quoteValue["']/gi) ?? []).length
            }
            const firstOddIdx = html.search(/data-matchoddid=/i)
            const firstOddSnippet = firstOddIdx >= 0
              ? html.slice(Math.max(0, firstOddIdx - 250), Math.min(html.length, firstOddIdx + 900)).replace(/\s+/g, " ").trim()
              : null
            return json({
              matchId,
              fetch: { target, status: fetched.status, contentType: fetched.contentType, length: html.length, finalUrl: fetched.finalUrl },
              signals,
              parse: { markets: markets.length, outcomes: markets.reduce((a, m) => a + (m.outcomes?.length ?? 0), 0) },
              firstOddSnippet,
              markets
            })
          }

          return json({ matchId, markets })
        } catch (e) {
          return json({ error: String(e) }, 500)
        }
      }
      if (p.startsWith("/api/odds/prematch/")) {
        const sportKey = decodeURIComponent(p.slice("/api/odds/prematch/".length))
        try {
          return await serveOdds(env, sportKey, false)
        } catch (e) {
          return json({ error: String(e) }, 500)
        }
      }
      if (p.startsWith("/api/odds/live/")) {
        const sportKey = decodeURIComponent(p.slice("/api/odds/live/".length))
        try {
          return await serveOdds(env, sportKey, true)
        } catch (e) {
          return json({ error: String(e) }, 500)
        }
      }
    }
    return notFound()
  },
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    if (event.cron === "*/1 * * * *") {
      ctx.waitUntil(runLive(env))
    } else if (event.cron === "*/10 * * * *") {
      ctx.waitUntil(runPrematch(env))
    }
  }
}
