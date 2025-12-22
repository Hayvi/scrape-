import { formatPriceOrDash, normLite } from "./utils.js"

export function marketCategoryKey(m) {
  const k = normLite(m?.key)
  const n = normLite(m?.name)
  const s = `${k} ${n}`
  const isPopular =
    s.includes("1x2") ||
    s.includes("match result") ||
    s.includes("resultat") ||
    s.includes("double chance") ||
    s.includes("draw no bet") ||
    s.includes("btts") ||
    s.includes("both teams") ||
    s.includes("over") ||
    s.includes("under") ||
    s.includes("plus") ||
    s.includes("moins")
  if (isPopular) return "popular"
  if (s.includes("but") || s.includes("goal") || s.includes("buts")) return "goals"
  if (s.includes("handicap")) return "handicap"
  if (s.includes("1ere") || s.includes("1er") || s.includes("1st half") || s.includes("first half") || s.includes("mi-temps") || s.includes("mi temps")) return "first_half"
  if (s.includes("2eme") || s.includes("2nd half") || s.includes("second half")) return "second_half"
  if (s.includes("cart") || s.includes("card") || s.includes("carton")) return "cards"
  if (s.includes("corner") || s.includes("corners")) return "corners"
  if (s.includes("combo")) return "combo"
  if (s.includes("minute") || s.includes("min ") || s.includes("temps")) return "minute"
  if (!k && !n) return "uncategorized"
  return "other"
}

export function groupMarkets(extra) {
  const markets = Array.isArray(extra?.markets) ? extra.markets : []
  const groups = new Map()
  for (const m of markets) {
    const ck = marketCategoryKey(m)
    if (!groups.has(ck)) groups.set(ck, [])
    groups.get(ck).push(m)
  }
  return { markets, groups }
}

export function categoryLabel(key) {
  if (key === "popular") return "Populaire"
  if (key === "goals") return "BUTS"
  if (key === "handicap") return "HANDICAP"
  if (key === "first_half") return "1ÈRE MOITIÉ"
  if (key === "second_half") return "2ÈME MOITIE"
  if (key === "cards") return "CARTES"
  if (key === "corners") return "CORNERS"
  if (key === "combo") return "COMBO MARKETS"
  if (key === "minute") return "MINUTE"
  if (key === "uncategorized") return "Hors catégorie"
  return "AUTRES"
}

export function renderMarketOutcomes(m) {
  const outs = Array.isArray(m?.outcomes) ? m.outcomes : []
  if (!outs.length) return ""
  const pills = outs
    .map((o) => {
      const lab = String(o?.label ?? "")
      const h = o?.handicap == null ? "" : ` ${String(o.handicap)}`
      const p = formatPriceOrDash(o?.price)
      return `<span class="pill" style="margin:0; padding:6px 10px;">${lab}${h}: <b>${p}</b></span>`
    })
    .join("")
  return `<div style="display:flex; gap: 8px; flex-wrap: wrap; justify-content:flex-end;">${pills}</div>`
}

export function renderAllMarketsAccordion(matchKey, extra, state) {
  const { markets, groups } = groupMarkets(extra)
  const total = markets.length
  const meta = extra?.cached === true ? "cached" : "fresh"

  const order = [
    "popular",
    "goals",
    "handicap",
    "first_half",
    "second_half",
    "cards",
    "corners",
    "combo",
    "minute",
    "other",
    "uncategorized",
  ]

  const catState = state.expandedCats[matchKey] ?? {}
  const blocks = []
  for (const k of order) {
    const arr = groups.get(k) ?? []
    if (!arr.length) continue
    const outsCount = arr.reduce((a, m) => a + ((Array.isArray(m?.outcomes) ? m.outcomes.length : 0) || 0), 0)
    const open = Boolean(catState[k])
    blocks.push(`
            <div style="border-top: 1px solid rgba(255,255,255,.08);">
              <button type="button" data-cat="${k}" data-match="${matchKey}" style="width:100%; display:flex; align-items:center; justify-content:space-between; gap: 10px; padding: 12px 8px; background: transparent; border: none; color: rgba(255,255,255,.92); font-weight: 800; cursor: pointer;">
                <span>${categoryLabel(k)} (${arr.length} markets / ${outsCount} outcomes)</span>
                <span style="opacity:.75;">${open ? "▾" : "▸"}</span>
              </button>
              ${open ? `
                <div style="padding: 6px 8px 12px 8px; display:flex; flex-direction: column; gap: 10px;">
                  ${arr
                    .map((m) => {
                      const name = String(m?.name ?? m?.key ?? "Market")
                      return `
                        <div style="display:grid; grid-template-columns: 220px 1fr; gap: 12px; align-items:flex-start;">
                          <div style="opacity:.9; font-weight: 700;">${name}</div>
                          ${renderMarketOutcomes(m)}
                        </div>
                      `
                    })
                    .join("")}
                </div>
              ` : ""}
            </div>
          `)
  }

  return `
          <div style="display:flex; justify-content: space-between; gap: 10px; margin-bottom: 8px;">
            <div style="font-weight:800;">All markets</div>
            <div style="opacity:.7; font-size: 12px;">${meta} · ${total}</div>
          </div>
          <div>
            ${blocks.join("")}
          </div>
        `
}
