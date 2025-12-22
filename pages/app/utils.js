export function setText(el, v) {
  if (!el) return
  el.textContent = v == null ? "—" : String(v)
}

export function safeNumber(x) {
  const n = typeof x === "number" ? x : Number(x)
  return Number.isFinite(n) ? n : null
}

export function formatOdd(x) {
  const n = safeNumber(x)
  if (n === null) return null
  return n.toFixed(2)
}

export function normalizeLabel(s) {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
}

export function normalizeTeamName(s) {
  return normalizeLabel(s)
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export function pick1x2Market(markets) {
  const arr = Array.isArray(markets) ? markets : []
  const byKey = arr.find((m) => normalizeLabel(m.key) === "match" || normalizeLabel(m.key) === "1x2")
  if (byKey) return byKey
  const byName = arr.find((m) => {
    const n = normalizeLabel(m.name)
    return n.includes("match") || n.includes("1x2") || n.includes("1 x 2")
  })
  if (byName) return byName
  return arr[0] ?? null
}

export function extract1x2Odds(game) {
  const market = pick1x2Market(game?.markets)
  const outcomes = Array.isArray(market?.outcomes) ? market.outcomes : []
  const mapped = { home: null, draw: null, away: null }
  const homeN = normalizeTeamName(game?.homeTeam)
  const awayN = normalizeTeamName(game?.awayTeam)
  for (const o of outcomes) {
    const lab = normalizeLabel(o.label)
    const price = formatOdd(o.price)
    if (!price) continue
    if (lab === "1" || lab.includes("home") || lab.includes("team 1") || lab.includes("team1")) mapped.home = price
    else if (lab === "x" || lab.includes("draw") || lab.includes("nul")) mapped.draw = price
    else if (lab === "2" || lab.includes("away") || lab.includes("team 2") || lab.includes("team2")) mapped.away = price
    else {
      const t = normalizeTeamName(o.label)
      if (t && homeN && (t === homeN || homeN.includes(t) || t.includes(homeN))) mapped.home = price
      else if (t && awayN && (t === awayN || awayN.includes(t) || t.includes(awayN))) mapped.away = price
    }
  }

  if ((!mapped.home || !mapped.draw || !mapped.away) && outcomes.length >= 3) {
    const first3 = outcomes
      .slice(0, 3)
      .map((o) => ({ label: normalizeLabel(o.label), price: formatOdd(o.price) }))
      .filter((o) => o.price)
    if (first3.length === 3) {
      const xIdx = first3.findIndex((o) => o.label === "x" || o.label.includes("draw") || o.label.includes("nul"))
      if (xIdx !== -1) {
        const other = [0, 1, 2].filter((i) => i !== xIdx)
        mapped.draw = mapped.draw ?? first3[xIdx].price
        mapped.home = mapped.home ?? first3[other[0]].price
        mapped.away = mapped.away ?? first3[other[1]].price
      } else {
        mapped.home = mapped.home ?? first3[0].price
        mapped.draw = mapped.draw ?? first3[1].price
        mapped.away = mapped.away ?? first3[2].price
      }
    }
  }
  return mapped
}

export function has1x2Odds(game) {
  const o = extract1x2Odds(game)
  return Boolean(o.home && o.draw && o.away)
}

export function formatDateLong(d) {
  try {
    return new Intl.DateTimeFormat(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" }).format(d)
  } catch {
    return d.toISOString()
  }
}

export function formatDayShort(d) {
  try {
    return new Intl.DateTimeFormat(undefined, { weekday: "long", day: "2-digit", month: "long" }).format(d)
  } catch {
    return d.toISOString()
  }
}

export function formatKickoff(startTime) {
  const d = new Date(startTime)
  if (!Number.isFinite(d.getTime())) return "--:--"
  try {
    return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(d)
  } catch {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
  }
}

export function formatCountdown(startTime, mode) {
  const d = new Date(startTime)
  if (!Number.isFinite(d.getTime())) return null
  const ms = d.getTime() - Date.now()
  if (ms <= 0) return mode === "live" ? "LIVE" : null
  const hours = Math.floor(ms / 36e5)
  const days = Math.floor(hours / 24)
  const remH = hours % 24
  if (days > 0) return `${days}d ${remH}h`
  return `${hours}h`
}

export function normLite(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
}

export function formatPriceOrDash(x) {
  const p = formatOdd(x)
  return p == null ? "—" : p
}
