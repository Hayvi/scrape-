export async function fetchWithRetry(url: string, init: RequestInit = {}, attempts = 3, timeoutMs = 10000): Promise<Response> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const res = await fetch(url, { ...init, signal: ac.signal })
      clearTimeout(t)
      if (res.ok) return res
      lastErr = new Error(`HTTP ${res.status}`)
    } catch (e) {
      lastErr = e
    }
    await new Promise(r => setTimeout(r, 300 * (i + 1)))
  }
  throw lastErr instanceof Error ? lastErr : new Error("fetch failed")
}

async function fetchResponseWithRetry(url: string, init: RequestInit = {}, attempts = 3, timeoutMs = 10000): Promise<Response> {
  let lastRes: Response | null = null
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const res = await fetch(url, { ...init, signal: ac.signal })
      clearTimeout(t)
      lastRes = res
      return res
    } catch (e) {
      lastErr = e
    }
    await new Promise(r => setTimeout(r, 300 * (i + 1)))
  }
  if (lastRes) return lastRes
  throw lastErr instanceof Error ? lastErr : new Error("fetch failed")
}

function buildCookieHeader(cookies: Record<string, string>): string | undefined {
  const entries = Object.entries(cookies)
  if (!entries.length) return undefined
  return entries.map(([k, v]) => `${k}=${v}`).join("; ")
}

async function getHTMLWithDdosBypass(url: string, baseHeaders?: HeadersInit): Promise<string> {
  const headersBase: Record<string, string> = {
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    ...((baseHeaders ?? {}) as Record<string, string>)
  }
  let current = url
  const cookies: Record<string, string> = {}
  for (let i = 0; i < 5; i++) {
    const headers: Record<string, string> = { ...headersBase }
    const cookieHeader = buildCookieHeader(cookies)
    if (cookieHeader) headers["cookie"] = cookieHeader
    headers["referer"] = new URL(current).origin + "/"
    const res = await fetchWithRetry(current, { headers })
    // Capture Set-Cookie headers if present
    const setCookie = res.headers.get("set-cookie")
    if (setCookie) {
      // Handle multiple cookies if comma-separated (best-effort)
      const parts = setCookie.split(/,(?=[^;]+=[^;]+)/)
      for (const p of parts) {
        const m = p.match(/([^=;\s]+)=([^;]+)/)
        if (m) cookies[m[1]] = m[2]
      }
    }
    const text = await res.text()
    // Detect JS-based DDOS gate
    const cookieMatch = text.match(/document\.cookie\s*=\s*"([^";=]+)=([^;]+)\s*;\s*path=\//i)
    const hrefMatch = text.match(/location\.href\s*=\s*"([^"]+)"/i)
    if (cookieMatch && hrefMatch) {
      const name = cookieMatch[1]
      const value = cookieMatch[2].trim()
      cookies[name] = value
      // Resolve relative or absolute next URL
      const nextHref = hrefMatch[1]
      try {
        current = new URL(nextHref, current).toString()
      } catch {
        current = nextHref
      }
      continue
    }
    return text
  }
  throw new Error("DDOS redirect loop exceeded")
}

export async function getTextWithDdosBypassSessionDetailed(url: string, baseHeaders: HeadersInit | undefined, cookies: Record<string, string>): Promise<{ status: number; finalUrl: string; text: string; contentType: string | null }> {
  const headersBase: Record<string, string> = {
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    ...((baseHeaders ?? {}) as Record<string, string>)
  }
  let current = url
  for (let i = 0; i < 7; i++) {
    const headers: Record<string, string> = { ...headersBase }
    const cookieHeader = buildCookieHeader(cookies)
    if (cookieHeader) headers["cookie"] = cookieHeader
    headers["referer"] = new URL(current).origin + "/"

    const res = await fetchResponseWithRetry(current, { headers })
    const setCookie = res.headers.get("set-cookie")
    if (setCookie) {
      const parts = setCookie.split(/,(?=[^;]+=[^;]+)/)
      for (const p of parts) {
        const m = p.match(/([^=;\s]+)=([^;]+)/)
        if (m) cookies[m[1]] = m[2]
      }
    }
    const text = await res.text()
    const cookieMatch = text.match(/document\.cookie\s*=\s*"([^";=]+)=([^;]+)\s*;\s*path=\//i)
    const hrefMatch = text.match(/location\.href\s*=\s*"([^"]+)"/i)
    if (cookieMatch && hrefMatch) {
      const name = cookieMatch[1]
      const value = cookieMatch[2].trim()
      cookies[name] = value
      const nextHref = hrefMatch[1]
      try {
        current = new URL(nextHref, current).toString()
      } catch {
        current = nextHref
      }
      continue
    }
    return { status: res.status, finalUrl: current, text, contentType: res.headers.get("content-type") }
  }
  throw new Error("DDOS redirect loop exceeded")
}

export async function getTextWithDdosBypass(url: string, headers?: HeadersInit): Promise<string> {
  return await getHTMLWithDdosBypass(url, headers)
}

export async function getTextWithDdosBypassDetailed(url: string, baseHeaders?: HeadersInit): Promise<{ status: number; finalUrl: string; text: string; contentType: string | null }> {
  const headersBase: Record<string, string> = {
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    ...((baseHeaders ?? {}) as Record<string, string>)
  }
  let current = url
  const cookies: Record<string, string> = {}
  for (let i = 0; i < 5; i++) {
    const headers: Record<string, string> = { ...headersBase }
    const cookieHeader = buildCookieHeader(cookies)
    if (cookieHeader) headers["cookie"] = cookieHeader
    headers["referer"] = new URL(current).origin + "/"

    const res = await fetchResponseWithRetry(current, { headers })
    const setCookie = res.headers.get("set-cookie")
    if (setCookie) {
      const parts = setCookie.split(/,(?=[^;]+=[^;]+)/)
      for (const p of parts) {
        const m = p.match(/([^=;\s]+)=([^;]+)/)
        if (m) cookies[m[1]] = m[2]
      }
    }
    const text = await res.text()
    const cookieMatch = text.match(/document\.cookie\s*=\s*"([^";=]+)=([^;]+)\s*;\s*path=\//i)
    const hrefMatch = text.match(/location\.href\s*=\s*"([^"]+)"/i)
    if (cookieMatch && hrefMatch) {
      const name = cookieMatch[1]
      const value = cookieMatch[2].trim()
      cookies[name] = value
      const nextHref = hrefMatch[1]
      try {
        current = new URL(nextHref, current).toString()
      } catch {
        current = nextHref
      }
      continue
    }
    return { status: res.status, finalUrl: current, text, contentType: res.headers.get("content-type") }
  }
  throw new Error("DDOS redirect loop exceeded")
}

export async function getPrematchHTML(): Promise<string> {
  const headers = {
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
  }
  try {
    return await getHTMLWithDdosBypass("https://tounesbet.com/Prematch", headers)
  } catch {
    return await getHTMLWithDdosBypass("http://tounesbet.com/Prematch", headers)
  }
}

export async function getNextMatchesHTML(sportId: string | number): Promise<string> {
  const headers = {
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    "x-requested-with": "XMLHttpRequest"
  }
  const qs = `SportId=${encodeURIComponent(String(sportId))}`
  try {
    return await getHTMLWithDdosBypass(`https://tounesbet.com/Match/NextMatches?${qs}`, headers)
  } catch {
    return await getHTMLWithDdosBypass(`http://tounesbet.com/Match/NextMatches?${qs}`, headers)
  }
}

export async function getSportMatchListHTML(sportId: string | number, betRangeFilter = "0", pageNumber = 1): Promise<string> {
  const headers = {
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    "x-requested-with": "XMLHttpRequest"
  }

  const qsNew = `BetRangeFilter=${encodeURIComponent(String(betRangeFilter))}&Page_number=${encodeURIComponent(String(pageNumber))}&d=1&DateDay=all_days`
  const urlsNew = [`https://tounesbet.com/Sport/${encodeURIComponent(String(sportId))}?${qsNew}`, `http://tounesbet.com/Sport/${encodeURIComponent(String(sportId))}?${qsNew}`]

  for (const u of urlsNew) {
    try {
      const html = await getHTMLWithDdosBypass(u, headers)
      if (/data-matchid=["']\d+["']/i.test(html) || /matchesTableBody/i.test(html)) return html
    } catch {
    }
  }

  const qsLegacy = `SportId=${encodeURIComponent(String(sportId))}&BetRangeFilter=${encodeURIComponent(String(betRangeFilter))}&Page_number=${encodeURIComponent(String(pageNumber))}&d=1&DateDay=all_days`
  try {
    return await getHTMLWithDdosBypass(`https://tounesbet.com/Sport/matchList?${qsLegacy}`, headers)
  } catch {
    return await getHTMLWithDdosBypass(`http://tounesbet.com/Sport/matchList?${qsLegacy}`, headers)
  }
}

export async function getLiveHTML(): Promise<string> {
  const headers = {
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
  }

  try {
    const html = await getHTMLWithDdosBypass("https://tounesbet.com/paris-sportif-live", headers)
    if (/<table[^>]*id=["']live_matches_table["']/i.test(html)) return html
  } catch {
  }
  try {
    const html = await getHTMLWithDdosBypass("http://tounesbet.com/paris-sportif-live", headers)
    if (/<table[^>]*id=["']live_matches_table["']/i.test(html)) return html
  } catch {
  }

  try {
    return await getHTMLWithDdosBypass("https://tounesbet.com/Live", headers)
  } catch {
    return await getHTMLWithDdosBypass("http://tounesbet.com/Live", headers)
  }
}

export async function getPopularMatchesHTML(sportId: string | number, dateDay = "all_days", betRangeFilter = "0"): Promise<string> {
  const headers = {
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
  }
  const qs = `SportId=${encodeURIComponent(String(sportId))}&DateDay=${encodeURIComponent(dateDay)}&BetRangeFilter=${encodeURIComponent(String(betRangeFilter))}`
  try {
    return await getHTMLWithDdosBypass(`https://tounesbet.com/Match/PopularMatches?${qs}`, headers)
  } catch {
    return await getHTMLWithDdosBypass(`http://tounesbet.com/Match/PopularMatches?${qs}`, headers)
  }
}

export async function getSportHTML(sportId: string | number, betRangeFilter = "0"): Promise<string> {
  const headers = {
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
  }
  const qs = `SelectedSportId=${encodeURIComponent(String(sportId))}&BetRangeFilter=${encodeURIComponent(String(betRangeFilter))}`
  try {
    return await getHTMLWithDdosBypass(`https://tounesbet.com/Sport?${qs}`, headers)
  } catch {
    return await getHTMLWithDdosBypass(`http://tounesbet.com/Sport?${qs}`, headers)
  }
}

export async function getMatchOddsGroupedHTML(matchId: string | number): Promise<string> {
  const headers = {
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
  }
  const qs = `matchId=${encodeURIComponent(String(matchId))}`
  try {
    return await getHTMLWithDdosBypass(`https://tounesbet.com/Match/MatchOddsGrouped?${qs}`, headers)
  } catch {
    return await getHTMLWithDdosBypass(`http://tounesbet.com/Match/MatchOddsGrouped?${qs}`, headers)
  }
}
