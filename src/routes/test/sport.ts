import type { Env } from "../../env"
import { getTextWithDdosBypass, getTextWithDdosBypassDetailed, getTextWithDdosBypassSessionDetailed } from "../../fetcher"
import { json } from "../../http/response"
import { extractCandidatesFromJs, extractScriptSrcs, snippetAround, uniqLimit } from "../../http/utils"

export async function handleTestSportRoutes(_request: Request, env: Env, url: URL, p: string): Promise<Response | null> {
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

      const inlinePaths = uniqLimit(inlinePathsAll, 120)
      const inlineTokens = uniqLimit(inlineTokensAll, 120)

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
          paths: inlinePaths,
          tokens: inlineTokens
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

  return null
}
