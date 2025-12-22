import { persistParsed, runLive, runPrematchDiscovery, runPrematchHourly, servePrematchFullMarkets } from "./service"
import { getLiveHTML, getNextMatchesHTML, getSportMatchListHTML, getTextWithDdosBypass, getTextWithDdosBypassDetailed, getTextWithDdosBypassSessionDetailed } from "./fetcher"
import { parseLive, parseMatchOddsGrouped, parsePrematchNextMatches, parsePrematchSportMatchList } from "./parser"
import { claimScrapeTasks, getClient, upsertLiveMeta, upsertScrapeQueue } from "./db"
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

async function serveOdds(env: Env, url: URL, sportKey: string, live: boolean) {
  const db = getClient(env)
  const source = "tounesbet"
  const s = await db.from("sports").select("id,key,name").eq("source", source).eq("key", sportKey).maybeSingle()
  if (!s.data) return notFound("sport")
  const sportId = s.data.id
  const leagues = await db.from("leagues").select("id,name").eq("sport_id", sportId)
  const leaguesData = (leagues.data ?? []) as { id: number; name: string }[]
  const leagueIds = leaguesData.map((l) => l.id)
  if (!leagueIds.length) return json({ sport: { key: s.data.key, name: s.data.name }, leagues: [] })
  const includeStartedFlag = url.searchParams.get("includeStarted") === "1"
  const includeStale = url.searchParams.get("includeStale") === "1"
  const seenWithinMinutes = Math.max(0, Math.min(7 * 24 * 60, Number(url.searchParams.get("seenWithinMinutes") ?? "180") || 180))
  const seenCutoffIso = new Date(Date.now() - seenWithinMinutes * 60 * 1000).toISOString()
  let gamesQ = db.from("games")
    .select("id,external_id,league_id,home_team,away_team,start_time,live,last_seen_at")
    .in("league_id", leagueIds)
    .eq("live", live)
  if (!live && !includeStartedFlag) {
    gamesQ = gamesQ.gt("start_time", new Date().toISOString())
  }
  if (!live && !includeStale && seenWithinMinutes > 0) {
    gamesQ = gamesQ.gte("last_seen_at", seenCutoffIso)
  }
  const games = await gamesQ
  const gamesData = (games.data ?? []) as { id: number; external_id: string; league_id: number; home_team: string; away_team: string; start_time: string; live: boolean; last_seen_at?: string }[]
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
      if (p === "/api/test/queue") {
        const db = getClient(env)
        const action = (url.searchParams.get("action") ?? "ping").toLowerCase()
        const source = url.searchParams.get("source") ?? "tounesbet"
        const task = url.searchParams.get("task") ?? "prematch_1x2"
        const externalId = url.searchParams.get("externalId") ?? ""
        const limit = Math.max(0, Math.min(50, Number(url.searchParams.get("limit") ?? "5") || 5))
        const lockOwner = url.searchParams.get("lockOwner") ?? "debug"
        try {
          if (action === "enqueue") {
            if (!externalId) return json({ error: "missing externalId" }, 400)
            await upsertScrapeQueue(db, [{ source, task, external_id: externalId, status: "pending", priority: 1 }])
            return json({ ok: true, action, source, task, externalId })
          }
          if (action === "expedite") {
            const upd = await db
              .from("scrape_queue")
              .update({ status: "pending", not_before_at: null, locked_at: null, lock_owner: null })
              .eq("source", source)
              .eq("task", task)
              .select("id", { count: "exact" })
            if (upd.error) return json({ error: JSON.stringify(upd.error), action, source, task }, 500)
            return json({ ok: true, action, source, task, updated: upd.count ?? null, sampleIds: (upd.data ?? []).slice(0, 20).map((r: any) => r.id) })
          }
          if (action === "peek") {
            const q = await db
              .from("scrape_queue")
              .select("id,source,task,external_id,status,priority,not_before_at,locked_at,lock_owner,attempts,last_error,last_success_at,created_at,updated_at")
              .eq("source", source)
              .eq("task", task)
              .order("priority", { ascending: false })
              .order("created_at", { ascending: true })
              .limit(limit)
            return json({ ok: true, action, source, task, limit, rows: q.data ?? [], error: q.error ? JSON.stringify(q.error) : null })
          }
          if (action === "release") {
            const idRaw = url.searchParams.get("id")
            const id = idRaw ? Number(idRaw) : NaN
            if (!Number.isFinite(id)) return json({ error: "missing id" }, 400)
            const { error } = await db.from("scrape_queue").update({ status: "pending", locked_at: null, lock_owner: null }).eq("id", id)
            if (error) return json({ error: JSON.stringify(error) }, 500)
            return json({ ok: true, action, id })
          }
          if (action === "claim") {
            const claimed = await claimScrapeTasks(db, source, task, limit, lockOwner)
            return json({ ok: true, action, source, task, limit, claimed })
          }
          const ping = await claimScrapeTasks(db, source, task, 0, lockOwner)
          return json({ ok: true, action: "ping", source, task, rpc: "claim_scrape_tasks", resultCount: ping.length })
        } catch (e) {
          return json({ error: String(e), action, source, task }, 500)
        }
      }

      if (p === "/api/test/matchlist_parse_debug") {
        const sportId = url.searchParams.get("sportId") ?? env.DEFAULT_SPORT_ID ?? "1181"
        const betRangeFilter = url.searchParams.get("betRangeFilter") ?? "0"
        const page = Math.max(1, Math.min(250, Number(url.searchParams.get("page") ?? "1") || 1))
        try {
          const html = await getSportMatchListHTML(String(sportId), String(betRangeFilter), page)
          const nowMs = Date.now()
          const parsed = parsePrematchNextMatches(html, String(sportId))
          const parsed2 = parsePrematchSportMatchList(html, String(sportId))
          const games = parsed2.flatMap(s => s.leagues).flatMap(l => l.games)
          const fallback = games.filter(g => {
            const t = Date.parse(String(g.start_time))
            return Number.isFinite(t) && Math.abs(t - nowMs) < 2 * 60 * 1000
          }).length

          const fullDates = (html.match(/\d{2}\/\d{2}\/\d{4}/g) ?? []).length
          const shortDates = (html.match(/\d{2}\/\d{2}(?!\/\d{4})/g) ?? []).length
          const times = (html.match(/\b\d{2}:\d{2}(?::\d{2})?\b/g) ?? []).length
          const matchIds = Array.from(new Set((html.match(/data-matchid=["'](\d+)["']/gi) ?? []).map(x => x.match(/(\d+)/)?.[1]).filter(Boolean)))

          return json({
            sportId,
            betRangeFilter,
            page,
            fetched: {
              length: html.length,
              snippet: html.slice(0, 1200).replace(/\s+/g, " ").trim()
            },
            html_stats: { match_ids: matchIds.length, full_dates: fullDates, short_dates: shortDates, times },
            parsed_stats: {
              parsed_games: games.length,
              fallback_start_time_count: fallback,
              next_matches_parser_games: parsed.flatMap(s => s.leagues).flatMap(l => l.games).length
            },
            sample: games.slice(0, 8).map(g => ({ id: g.external_id, start_time: g.start_time, home: g.home_team, away: g.away_team }))
          })
        } catch (e) {
          return json({ error: String(e), sportId, betRangeFilter, page }, 500)
        }
      }

      if (p === "/api/test/matchlist_fetch_debug") {
        const sportId = url.searchParams.get("sportId") ?? env.DEFAULT_SPORT_ID ?? "1181"
        const betRangeFilter = url.searchParams.get("betRangeFilter") ?? "0"
        const page = Math.max(1, Math.min(250, Number(url.searchParams.get("page") ?? "1") || 1))
        const variant = (url.searchParams.get("variant") ?? "both").toLowerCase()
        const xhr = url.searchParams.get("xhr") !== "0"
        const dateDay = url.searchParams.get("dateDay")

        const baseHeaders: Record<string, string> = {
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
        }
        if (xhr) baseHeaders["x-requested-with"] = "XMLHttpRequest"

        const dateDayQs = dateDay ? `&DateDay=${encodeURIComponent(String(dateDay))}` : ""
        const qsNew = `BetRangeFilter=${encodeURIComponent(String(betRangeFilter))}&Page_number=${encodeURIComponent(String(page))}&d=1${dateDayQs}`
        const qsLegacy = `SportId=${encodeURIComponent(String(sportId))}&BetRangeFilter=${encodeURIComponent(String(betRangeFilter))}&Page_number=${encodeURIComponent(String(page))}&d=1${dateDayQs}`
        const targets: { kind: string; url: string }[] = []
        if (variant === "new" || variant === "both") {
          targets.push({ kind: "new_https", url: `https://tounesbet.com/Sport/${encodeURIComponent(String(sportId))}?${qsNew}` })
          targets.push({ kind: "new_http", url: `http://tounesbet.com/Sport/${encodeURIComponent(String(sportId))}?${qsNew}` })
        }
        if (variant === "legacy" || variant === "both") {
          targets.push({ kind: "legacy_https", url: `https://tounesbet.com/Sport/matchList?${qsLegacy}` })
          targets.push({ kind: "legacy_http", url: `http://tounesbet.com/Sport/matchList?${qsLegacy}` })
        }

        const results: any[] = []
        for (const t of targets) {
          try {
            const res = await getTextWithDdosBypassDetailed(t.url, baseHeaders)
            const text = res.text
            const matchIdCount = (text.match(/data-matchid=["']\d+["']/gi) ?? []).length
            const signals = {
              matchIdCount,
              matchesTableBody: (text.match(/matchesTableBody/gi) ?? []).length,
              ddosGate: /document\.cookie\s*=\s*"[^";=]+=[^;]+\s*;\s*path=\//i.test(text),
              cloudflare: /cloudflare|attention required|cf-ray|checking your browser/i.test(text)
            }
            results.push({ kind: t.kind, target: t.url, status: res.status, finalUrl: res.finalUrl, contentType: res.contentType, length: text.length, signals, snippet: text.slice(0, 1200).replace(/\s+/g, " ").trim() })
          } catch (e) {
            results.push({ kind: t.kind, target: t.url, error: String(e) })
          }
        }
        return json({ sportId, betRangeFilter, page, variant, xhr, dateDay: dateDay ?? null, results })
      }

      if (p === "/api/test/sport_discover") {
        const sportId = url.searchParams.get("sportId") ?? env.DEFAULT_SPORT_ID ?? "1181"
        const betRangeFilter = url.searchParams.get("betRangeFilter") ?? "0"
        const base = "https://tounesbet.com"
        const targetHttps = `${base}/Sport?SelectedSportId=${encodeURIComponent(String(sportId))}&BetRangeFilter=${encodeURIComponent(String(betRangeFilter))}`
        const targetHttp = `http://tounesbet.com/Sport?SelectedSportId=${encodeURIComponent(String(sportId))}&BetRangeFilter=${encodeURIComponent(String(betRangeFilter))}`
        try {
          const headers = {
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "accept-language": "en-US,en;q=0.9",
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
            "x-requested-with": "XMLHttpRequest"
          }
          let htmlRes = await getTextWithDdosBypassDetailed(targetHttps, headers)
          if (!(htmlRes.status >= 200 && htmlRes.status < 300)) {
            htmlRes = await getTextWithDdosBypassDetailed(targetHttp, headers)
          }
          const html = htmlRes.text
          const hasSportCategories = /id=["']Sport_categories["']/i.test(html)
          const hasUpdateFnCall = /updateCollapsePictureSportCateg\(/i.test(html)
          const scriptSrcs = extractScriptSrcs(html, 20)

          const flags = {
            cloudflare: /cloudflare|attention required|cf-ray|checking your browser/i.test(html),
            captcha: /captcha|recaptcha|hcaptcha/i.test(html),
            ddosGate: /document\.cookie\s*=\s*"[^";=]+=[^;]+\s*;\s*path=\//i.test(html)
          }
          const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() ?? null
          const snippet = html.slice(0, 2500).replace(/\s+/g, " ").trim()

          const htmlPathsRaw = html.match(/\/[A-Za-z0-9][A-Za-z0-9\/._-]{2,}/g) ?? []
          const htmlPaths = uniqLimit(
            htmlPathsRaw.filter(p => /sport|categ|category|tournament|league|prematch|match/i.test(p)),
            200
          )

          const inlineScriptBlocks: string[] = []
          const scriptRe = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi
          let sm: RegExpExecArray | null
          while ((sm = scriptRe.exec(html)) !== null) {
            const body = String(sm[1] ?? "")
            if (!body.trim()) continue
            inlineScriptBlocks.push(body)
            if (inlineScriptBlocks.length >= 6) break
          }

          const inlineCandidates: any[] = []
          const inlinePathsAll: string[] = []
          const inlineTokensAll: string[] = []
          for (const js of inlineScriptBlocks) {
            const c = extractCandidatesFromJs(js)
            inlineCandidates.push({ paths: c.paths.slice(0, 30), tokens: c.tokens.slice(0, 30) })
            inlinePathsAll.push(...c.paths)
            inlineTokensAll.push(...c.tokens)
          }

          const hintsInHtml = {
            updateCollapsePictureSportCateg: snippetAround(html, "updateCollapsePictureSportCateg", 900),
            sport_categories: snippetAround(html, "sport_categories", 900),
            Sport_categories: snippetAround(html, "Sport_categories", 900)
          }

          const keywords = ["Sport_categories", "sport_categories", "updateCollapsePictureSportCateg", "categories", "tournament", "league", "prematch"]
          const perScript: any[] = []
          const pathsAll: string[] = []
          const tokensAll: string[] = []

          const prioritized = uniqLimit(
            [
              ...scriptSrcs.filter(s => /sport|match|main|bundle|app|site|flashbet|libs/i.test(s)),
              ...scriptSrcs
            ],
            8
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
              const sportishPaths = uniqLimit(
                (js.match(/\/[A-Za-z0-9][A-Za-z0-9\/._-]{2,}/g) ?? []).filter(p => /sport|categ|category|tournament|league|prematch|match/i.test(p)),
                120
              )
              const snippets: Record<string, string | null> = {}
              for (const k of keywords) snippets[k] = snippetAround(js, k, 900)

              perScript.push({
                src,
                length: js.length,
                candidatePaths: sportishPaths.slice(0, 50),
                paths: c.paths.slice(0, 30),
                tokens: c.tokens.slice(0, 30),
                snippets
              })
              pathsAll.push(...sportishPaths)
              tokensAll.push(...c.tokens)
            } catch (e) {
              perScript.push({ src, error: String(e) })
            }
          }

          return json({
            target: htmlRes.finalUrl,
            status: htmlRes.status,
            contentType: htmlRes.contentType,
            htmlLength: html.length,
            title,
            flags,
            snippet,
            hasSportCategories,
            hasUpdateFnCall,
            scriptSrcs,
            htmlPaths,
            inline: {
              inlineScriptCount: inlineScriptBlocks.length,
              inlineCandidates,
              paths: uniqLimit(inlinePathsAll, 120),
              tokens: uniqLimit(inlineTokensAll, 120)
            },
            hintsInHtml,
            discovered: {
              paths: uniqLimit([...htmlPaths, ...inlinePathsAll, ...pathsAll], 240),
              tokens: uniqLimit([...inlineTokensAll, ...tokensAll], 240),
              perScript
            }
          })
        } catch (e) {
          return json({ target: targetHttps, error: String(e) }, 500)
        }
      }

      if (p === "/api/test/sport_paging") {
        const sportId = url.searchParams.get("sportId") ?? env.DEFAULT_SPORT_ID ?? "1181"
        const betRangeFilter = url.searchParams.get("betRangeFilter") ?? "0"
        const received = url.searchParams.get("receivedTournamentCount") ?? "4"
        const cookies: Record<string, string> = {}
        const headers = {
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
          "x-requested-with": "XMLHttpRequest"
        }
        const base = "https://tounesbet.com"
        const initialUrl = `${base}/Sport/matchList?SportId=${encodeURIComponent(String(sportId))}&BetRangeFilter=${encodeURIComponent(String(betRangeFilter))}`
        const nextUrl = `${base}/Sport/loadFeaturedTournaments?SportId=${encodeURIComponent(String(sportId))}&BetRangeFilter=${encodeURIComponent(String(betRangeFilter))}&receivedTournamentCount=${encodeURIComponent(String(received))}`
        try {
          const a = await getTextWithDdosBypassSessionDetailed(initialUrl, headers, cookies)
          const aTournaments = Array.from(new Set((a.text.match(/data-tournamentid=["'](\d+)["']/gi) ?? []).map(x => x.match(/(\d+)/)?.[1]).filter(Boolean)))
          const aMatches = Array.from(new Set((a.text.match(/data-matchid=["'](\d+)["']/gi) ?? []).map(x => x.match(/(\d+)/)?.[1]).filter(Boolean)))
          const aReceived = a.text.match(/class=["']receivedTournamentCount["'][^>]*value=["'](\d+)["']/i)?.[1] ?? null

          const b = await getTextWithDdosBypassSessionDetailed(nextUrl, headers, cookies)
          const bTournaments = Array.from(new Set((b.text.match(/data-tournamentid=["'](\d+)["']/gi) ?? []).map(x => x.match(/(\d+)/)?.[1]).filter(Boolean)))
          const bMatches = Array.from(new Set((b.text.match(/data-matchid=["'](\d+)["']/gi) ?? []).map(x => x.match(/(\d+)/)?.[1]).filter(Boolean)))
          const bReceived = b.text.match(/class=["']receivedTournamentCount["'][^>]*value=["'](\d+)["']/i)?.[1] ?? null

          const newTournamentIds = bTournaments.filter(t => !aTournaments.includes(t))
          const newMatchIds = bMatches.filter(m => !aMatches.includes(m))

          return json({
            sportId,
            betRangeFilter,
            requestedReceivedTournamentCount: received,
            cookieKeys: Object.keys(cookies),
            initial: {
              url: a.finalUrl,
              status: a.status,
              receivedTournamentCount: aReceived,
              tournamentCount: aTournaments.length,
              tournamentIdsSample: aTournaments.slice(0, 12),
              matchCount: aMatches.length,
              matchIdsSample: aMatches.slice(0, 12)
            },
            next: {
              url: b.finalUrl,
              status: b.status,
              receivedTournamentCount: bReceived,
              tournamentCount: bTournaments.length,
              tournamentIdsSample: bTournaments.slice(0, 12),
              matchCount: bMatches.length,
              matchIdsSample: bMatches.slice(0, 12)
            },
            delta: {
              newTournamentCount: newTournamentIds.length,
              newTournamentIdsSample: newTournamentIds.slice(0, 15),
              newMatchCount: newMatchIds.length,
              newMatchIdsSample: newMatchIds.slice(0, 15)
            }
          })
        } catch (e) {
          return json({ error: String(e), initialUrl, nextUrl }, 500)
        }
      }

      if (p === "/api/test/matchlist_js") {
        const sportId = url.searchParams.get("sportId") ?? env.DEFAULT_SPORT_ID ?? "1181"
        const betRangeFilter = url.searchParams.get("betRangeFilter") ?? "0"
        const base = "https://tounesbet.com"
        const pageUrl = `${base}/Sport/matchList?SportId=${encodeURIComponent(String(sportId))}&BetRangeFilter=${encodeURIComponent(String(betRangeFilter))}`
        try {
          const htmlRes = await getTextWithDdosBypassDetailed(pageUrl, {
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "accept-language": "en-US,en;q=0.9",
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
          })
          const html = htmlRes.text
          const m = html.match(/<script[^>]*\ssrc=["']([^"']*\/bundles\/flashbet-libs\?v=[^"']+)["'][^>]*>/i)
          const src = m ? m[1] : null
          if (!src) return json({ error: "flashbet-libs bundle not found", pageUrl: htmlRes.finalUrl }, 500)
          const fullSrc = src.startsWith("http") ? src : `${base}${src}`

          const js = await getTextWithDdosBypass(fullSrc, {
            accept: "text/javascript,application/javascript,*/*;q=0.1",
            "accept-language": "en-US,en;q=0.9",
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
          })
          const needle = "function matchList("
          const idx = js.indexOf(needle)
          if (idx < 0) return json({ error: "matchList() function not found in bundle", bundle: fullSrc }, 500)
          const snippet = js.slice(idx, Math.min(js.length, idx + 12000)).replace(/\s+/g, " ").trim()
          return json({
            pageUrl: htmlRes.finalUrl,
            bundle: fullSrc,
            snippet
          })
        } catch (e) {
          return json({ error: String(e), pageUrl }, 500)
        }
      }

      if (p === "/api/test/run/prematch_hourly") {
        const batch = Math.max(1, Math.min(100, Number(url.searchParams.get("batch") ?? "40") || 40))
        try {
          const res = await runPrematchHourly(env as any, batch)
          return json({ ok: true, batch, res })
        } catch (e) {
          return json({ error: String(e) }, 500)
        }
      }

      if (p === "/api/test/run/prematch_discovery") {
        try {
          const batch = Math.max(1, Math.min(8, Number(url.searchParams.get("batch") ?? "3") || 3))
          const res = await runPrematchDiscovery(env as any, { batch })
          return json({ ok: true, batch, res })
        } catch (e) {
          return json({ ok: false, error: String(e) }, 200)
        }
      }

      if (p === "/api/test/stats") {
        const db = getClient(env)
        const source = url.searchParams.get("source") ?? "tounesbet"
        const sportKey = url.searchParams.get("sportKey")
        try {
          let leagueIds: number[] | null = null
          if (sportKey) {
            const s = await db.from("sports").select("id").eq("source", source).eq("key", sportKey).maybeSingle()
            if (!s.data?.id) return json({ error: "sport not found", source, sportKey }, 404)
            const leagues = await db.from("leagues").select("id").eq("sport_id", s.data.id)
            leagueIds = (leagues.data ?? []).map((r: any) => Number(r.id)).filter((x: any) => Number.isFinite(x))
          }

          const nowIso = new Date().toISOString()
          const includeStale = url.searchParams.get("includeStale") === "1"
          const seenWithinMinutes = Math.max(0, Math.min(7 * 24 * 60, Number(url.searchParams.get("seenWithinMinutes") ?? "180") || 180))
          const seenCutoffIso = new Date(Date.now() - seenWithinMinutes * 60 * 1000).toISOString()

          let totalGamesQ = db
            .from("games")
            .select("id", { count: "exact", head: true })
            .eq("source", source)
            .eq("live", false)
          if (!includeStale && seenWithinMinutes > 0) totalGamesQ = totalGamesQ.gte("last_seen_at", seenCutoffIso)
          if (leagueIds) totalGamesQ = totalGamesQ.in("league_id", leagueIds)
          const totalGames = await totalGamesQ
          if (totalGames.error) throw new Error(`totalGames failed: ${JSON.stringify(totalGames.error)}`)

          let upcomingGamesQ = db
            .from("games")
            .select("id", { count: "exact", head: true })
            .eq("source", source)
            .eq("live", false)
            .gt("start_time", nowIso)
          if (!includeStale && seenWithinMinutes > 0) upcomingGamesQ = upcomingGamesQ.gte("last_seen_at", seenCutoffIso)
          if (leagueIds) upcomingGamesQ = upcomingGamesQ.in("league_id", leagueIds)
          const upcomingGames = await upcomingGamesQ
          if (upcomingGames.error) throw new Error(`upcomingGames failed: ${JSON.stringify(upcomingGames.error)}`)

          let startedGamesQ = db
            .from("games")
            .select("id", { count: "exact", head: true })
            .eq("source", source)
            .eq("live", false)
            .lte("start_time", nowIso)
          if (!includeStale && seenWithinMinutes > 0) startedGamesQ = startedGamesQ.gte("last_seen_at", seenCutoffIso)
          if (leagueIds) startedGamesQ = startedGamesQ.in("league_id", leagueIds)
          const startedGames = await startedGamesQ
          if (startedGames.error) throw new Error(`startedGames failed: ${JSON.stringify(startedGames.error)}`)

          const gamesWith1x2Market = await db
            .from("markets")
            .select("game_id", { count: "exact", head: true })
            .eq("source", source)
            .eq("key", "1x2")
          if (gamesWith1x2Market.error) throw new Error(`gamesWith1x2Market failed: ${JSON.stringify(gamesWith1x2Market.error)}`)

          let gamesWithComplete1x2: unknown = null
          let rpcError: unknown = null
          try {
            const complete1x2 = await db.rpc("stats_prematch_complete_1x2", { p_source: source })
            if (complete1x2.error) {
              rpcError = complete1x2.error
            } else {
              gamesWithComplete1x2 = (complete1x2.data?.[0]?.games_with_complete_1x2 ?? complete1x2.data ?? null) as any
            }
          } catch (e) {
            rpcError = String(e)
          }

          return json({
            ok: true,
            source,
            sportKey: sportKey ?? null,
            seen_filter: { includeStale, seenWithinMinutes, seenCutoffIso },
            totals: {
              games: totalGames.count ?? null,
              games_upcoming_strict: upcomingGames.count ?? null,
              games_started_or_now: startedGames.count ?? null,
              games_with_1x2_market: gamesWith1x2Market.count ?? null,
              games_with_complete_1x2: gamesWithComplete1x2
            },
            rpc_error: rpcError
          })
        } catch (e) {
          return json({ error: String(e) }, 500)
        }
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
          return await serveOdds(env, url, sportKey, false)
        } catch (e) {
          return json({ error: String(e) }, 500)
        }
      }
      if (p.startsWith("/api/odds/live/")) {
        const sportKey = decodeURIComponent(p.slice("/api/odds/live/".length))
        try {
          return await serveOdds(env, url, sportKey, true)
        } catch (e) {
          return json({ error: String(e) }, 500)
        }
      }

      if (p.startsWith("/api/prematch/match/") && p.endsWith("/markets")) {
        const matchId = decodeURIComponent(p.slice("/api/prematch/match/".length, -"/markets".length))
        const fresh = url.searchParams.get("fresh") === "1"
        try {
          const data = await servePrematchFullMarkets(env as any, matchId, fresh)
          return json(data)
        } catch (e) {
          const msg = String(e)
          if (msg.includes("not_found:game")) {
            return json({ error: "match not in DB yet", matchId }, 404)
          }
          return json({ error: msg }, 500)
        }
      }
    }
    return notFound()
  },
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    if (event.cron === "*/1 * * * *") {
      ctx.waitUntil(Promise.allSettled([
        runLive(env),
        runPrematchDiscovery(env as any, { batch: 5 })
      ]))
    } else if (event.cron === "0 * * * *") {
      ctx.waitUntil(runPrematchHourly(env as any))
    } else if (event.cron === "5 */6 * * *") {
      ctx.waitUntil(runPrematchDiscovery(env as any, { batch: 5 }))
    }
  }
}
