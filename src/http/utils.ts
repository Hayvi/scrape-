export function safeBool(v: unknown) {
  return !!(v && String(v).trim().length)
}

export function extractWidgetLiveMatches(html: string, limit: number) {
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

export function capMarkets(markets: any[], maxMarkets = 40, maxOutcomes = 12) {
  const ms = markets.slice(0, maxMarkets)
  for (const m of ms) {
    if (Array.isArray(m?.outcomes)) m.outcomes = m.outcomes.slice(0, maxOutcomes)
  }
  return ms
}

export function snippetAround(haystack: string, needle: string, radius: number) {
  const idx = haystack.toLowerCase().indexOf(needle.toLowerCase())
  if (idx < 0) return null
  const start = Math.max(0, idx - radius)
  const end = Math.min(haystack.length, idx + radius)
  return haystack.slice(start, end).replace(/\s+/g, " ").trim()
}

export function extractScriptSrcs(html: string, max = 12) {
  const out: string[] = []
  const re = /<script[^>]*\ssrc=["']([^"']+)["'][^>]*>\s*<\/script>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    out.push(m[1])
    if (out.length >= max) break
  }
  return out
}

export function uniqLimit(values: string[], max: number) {
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

export function extractCandidatesFromJs(js: string) {
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

export function extractMatchIdsFromText(text: string, limit = 25) {
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
