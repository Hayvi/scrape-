import { getUi } from "./dom.js"
import { createState } from "./state.js"
import {
  extract1x2Odds,
  formatCountdown,
  formatDateLong,
  formatDayShort,
  formatKickoff,
} from "./utils.js"
import { renderAllMarketsAccordion } from "./markets.js"
import { renderSidebar } from "./sidebar.js"
import { createStats } from "./stats.js"

const ui = getUi()
const state = createState()
const stats = createStats(ui)

const SETTINGS_KEY = "os_tester_ui_settings_v1"
function readSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

const settings = readSettings()
function writeSetting(key, value) {
  try {
    settings[key] = value
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {}
}

function initSettingCheckbox(el, key, defaultValue) {
  if (!el) return
  const v = settings[key]
  el.checked = typeof v === "boolean" ? v : Boolean(defaultValue)
}

function initSettingNumber(el, key, defaultValue) {
  if (!el) return
  const v = settings[key]
  const n = Number(v)
  el.value = Number.isFinite(n) ? String(n) : String(defaultValue)
}

initSettingCheckbox(ui.onlyWithOdds, "onlyWithOdds", false)
initSettingCheckbox(ui.hideEmptyCompetitions, "hideEmptyCompetitions", true)
initSettingCheckbox(ui.oddsIncludeStale, "oddsIncludeStale", true)
initSettingCheckbox(ui.oddsIncludeStarted, "oddsIncludeStarted", false)
initSettingNumber(ui.oddsSeenMins, "oddsSeenMins", 180)

function apiOddsPath() {
  const base = state.mode === "live" ? "/api/odds/live/football" : "/api/odds/prematch/football"
  const params = new URLSearchParams()
  if (state.mode !== "live") {
    if (state.oddsIncludeStale) params.set("includeStale", "1")
    if (state.oddsIncludeStarted) params.set("includeStarted", "1")
    if (Number.isFinite(state.oddsSeenMins) && state.oddsSeenMins >= 0) params.set("seenWithinMinutes", String(state.oddsSeenMins))
  }
  const qs = params.toString()
  return qs ? `${base}?${qs}` : base
}

function renderMode() {
  if (state.mode === "prematch") {
    ui.modePrematch.classList.add("chip-active")
    ui.modeLive.classList.remove("chip-active")
  } else {
    ui.modeLive.classList.add("chip-active")
    ui.modePrematch.classList.remove("chip-active")
  }
}

function renderDebug() {
  ui.debugPanel.classList.toggle("hidden", !state.debugOpen)
}

function renderMain() {
  const leagues = state.data?.leagues ?? []
  const selected = leagues.find((l) => String(l.id) === String(state.selectedLeagueId)) ?? leagues[0] ?? null

  if (selected && state.selectedLeagueId == null) state.selectedLeagueId = selected.id

  ui.leagueName.textContent = selected?.name ?? "No league"
  ui.leagueDate.textContent = formatDateLong(new Date())
  ui.dayLabel.textContent = formatDayShort(new Date())

  const gamesAll = Array.isArray(selected?.games) ? selected.games : []
  const games = state.onlyWithOdds ? gamesAll.filter((g) => {
    const o = extract1x2Odds(g)
    return Boolean(o.home && o.draw && o.away)
  }) : gamesAll
  ui.matchCount.textContent = `${games.length} Matchs`

  ui.matchList.innerHTML = ""
  if (!games.length) {
    ui.matchList.innerHTML = `<div class="pill">No games in this league</div>`
    return
  }

  for (const g of games) {
    const card = document.createElement("div")
    card.className = "match-card"
    const kickoff = formatKickoff(g.startTime)
    const cd = formatCountdown(g.startTime, state.mode)
    const odds = extract1x2Odds(g)
    const matchKey = String(g.externalId ?? g.id ?? "")
    const expanded = Boolean(state.expanded[matchKey])
    const loading = Boolean(state.expandedLoading[matchKey])
    const err = state.expandedError[matchKey] ?? null
    const extra = state.expandedMarkets[matchKey] ?? null
    const totalMarkets = Array.isArray(extra?.markets) ? extra.markets.length : null
    const moreLabel = loading ? "..." : expanded ? "–" : totalMarkets != null ? `+${totalMarkets}` : "+"

    card.innerHTML = `
            <div class="match-left">
              <div class="time-pill">${kickoff}</div>
              ${cd ? `<div class="countdown">${cd}</div>` : ""}
            </div>
            <div class="match-mid">
              <div class="league-tag">${state.mode === "live" ? "LIVE" : "UEFA"}</div>
              <div class="teams">
                <div class="team"><div class="team-icon">H</div><div class="team-name">${String(g.homeTeam ?? "Home")}</div></div>
                <div class="team"><div class="team-icon">A</div><div class="team-name">${String(g.awayTeam ?? "Away")}</div></div>
              </div>
            </div>
            <div class="odds">
              <div class="odd ${odds.home ? "" : "odd-missing"}">${odds.home ?? "—"}</div>
              <div class="odd ${odds.draw ? "" : "odd-missing"}">${odds.draw ?? "—"}</div>
              <div class="odd ${odds.away ? "" : "odd-missing"}">${odds.away ?? "—"}</div>
              <button type="button" class="odd" data-more="1" data-matchid="${matchKey}" style="background: linear-gradient(180deg, rgba(16,185,129,.22), rgba(16,185,129,.10)); border-color: rgba(16,185,129,.35); color: rgba(236,253,245,.95);">
                ${moreLabel}
              </button>
            </div>
            ${expanded ? `
              <div class="pill" style="grid-column: 1 / -1; margin-top: 10px;">
                ${loading ? "Loading markets..." : err ? String(err) : extra ? renderAllMarketsAccordion(matchKey, extra, state) : "No extra markets"}
              </div>
            ` : ""}
          `

    const btn = card.querySelector("button[data-more='1']")
    if (btn) {
      btn.addEventListener("click", async () => {
        if (!matchKey) return
        state.expanded[matchKey] = !state.expanded[matchKey]
        state.expandedError[matchKey] = null
        if (!state.expandedCats[matchKey]) state.expandedCats[matchKey] = {}
        render()

        if (!state.expanded[matchKey]) return
        if (state.expandedMarkets[matchKey]) {
          render()
          return
        }
        state.expandedLoading[matchKey] = true
        render()
        try {
          const path = `/api/prematch/match/${encodeURIComponent(matchKey)}/markets`
          const res = await fetch(path, { headers: { accept: "application/json" } })
          if (!res.ok) {
            let body = null
            try {
              body = await res.json()
            } catch {}
            if (res.status === 404) throw new Error("Match not in DB yet. Refresh odds / run discovery.")
            throw new Error(body?.error ? String(body.error) : `HTTP ${res.status}`)
          }
          const data = await res.json()
          state.expandedMarkets[matchKey] = data
        } catch (e) {
          state.expandedError[matchKey] = String(e)
        } finally {
          state.expandedLoading[matchKey] = false
          render()
        }
      })
    }

    card.querySelectorAll("button[data-cat]").forEach((b) => {
      b.addEventListener("click", () => {
        const cat = b.getAttribute("data-cat")
        if (!cat) return
        if (!state.expandedCats[matchKey]) state.expandedCats[matchKey] = {}
        state.expandedCats[matchKey][cat] = !state.expandedCats[matchKey][cat]
        render()
      })
    })

    ui.matchList.appendChild(card)
  }
}

function render() {
  renderMode()
  renderSidebar(ui, state, render)
  renderMain()
  renderDebug()
}

async function send(path) {
  ui.out.textContent = "Loading..."
  ui.open.href = path
  try {
    const res = await fetch(path, { headers: { accept: "application/json" } })
    const text = await res.text()
    let pretty = text
    try {
      pretty = JSON.stringify(JSON.parse(text), null, 2)
    } catch {}
    ui.out.textContent = `HTTP ${res.status}\n\n${pretty}`
  } catch (e) {
    ui.out.textContent = String(e)
  }
}

async function loadOdds() {
  ui.matchList.innerHTML = `<div class="pill">Loading...</div>`
  const path = apiOddsPath()
  ui.pathInput.value = path
  ui.open.href = path
  try {
    const res = await fetch(path, { headers: { accept: "application/json" } })
    if (!res.ok) {
      const txt = await res.text()
      state.data = { leagues: [] }
      render()
      ui.out.textContent = `HTTP ${res.status}\n\n${txt}`
      state.debugOpen = true
      renderDebug()
      return
    }
    const json = await res.json()
    state.data = json
    const first = (state.data?.leagues ?? [])[0] ?? null
    if (first && state.selectedLeagueId == null) state.selectedLeagueId = first.id
    render()
  } catch (e) {
    state.data = { leagues: [] }
    render()
    ui.out.textContent = String(e)
    state.debugOpen = true
    renderDebug()
  }
}

ui.modePrematch.addEventListener("click", () => {
  state.mode = "prematch"
  state.selectedLeagueId = null
  loadOdds()
})

ui.modeLive.addEventListener("click", () => {
  state.mode = "live"
  state.selectedLeagueId = null
  loadOdds()
})

ui.refresh.addEventListener("click", () => loadOdds())

ui.onlyWithOdds.addEventListener("change", () => {
  state.onlyWithOdds = Boolean(ui.onlyWithOdds.checked)
  writeSetting("onlyWithOdds", state.onlyWithOdds)
  render()
})

if (ui.hideEmptyCompetitions) {
  ui.hideEmptyCompetitions.addEventListener("change", () => {
    state.hideEmptyCompetitions = Boolean(ui.hideEmptyCompetitions.checked)
    writeSetting("hideEmptyCompetitions", state.hideEmptyCompetitions)
    render()
  })
}

if (ui.oddsIncludeStale) {
  ui.oddsIncludeStale.addEventListener("change", () => {
    state.oddsIncludeStale = Boolean(ui.oddsIncludeStale.checked)
    writeSetting("oddsIncludeStale", state.oddsIncludeStale)
    loadOdds()
  })
}

if (ui.oddsIncludeStarted) {
  ui.oddsIncludeStarted.addEventListener("change", () => {
    state.oddsIncludeStarted = Boolean(ui.oddsIncludeStarted.checked)
    writeSetting("oddsIncludeStarted", state.oddsIncludeStarted)
    loadOdds()
  })
}

if (ui.oddsSeenMins) {
  ui.oddsSeenMins.addEventListener("change", () => {
    const n = Number(ui.oddsSeenMins.value)
    state.oddsSeenMins = Number.isFinite(n) ? Math.max(0, Math.min(10080, n)) : 180
    writeSetting("oddsSeenMins", state.oddsSeenMins)
    loadOdds()
  })
}

ui.debugToggle.addEventListener("click", () => {
  state.debugOpen = !state.debugOpen
  renderDebug()
})

ui.send.addEventListener("click", () => send(ui.pathInput.value))

if (ui.statsRefresh) ui.statsRefresh.addEventListener("click", () => stats.loadStats())
if (ui.statsAuto) ui.statsAuto.addEventListener("change", () => stats.syncStatsInterval())
if (ui.statsSeenMins) ui.statsSeenMins.addEventListener("change", () => stats.loadStats())

document.querySelectorAll("button[data-path]").forEach((b) => {
  b.addEventListener("click", () => {
    const p = b.getAttribute("data-path")
    ui.pathInput.value = p
    send(p)
  })
})

state.onlyWithOdds = Boolean(ui.onlyWithOdds && ui.onlyWithOdds.checked)
if (ui.hideEmptyCompetitions) state.hideEmptyCompetitions = Boolean(ui.hideEmptyCompetitions.checked)
if (ui.oddsIncludeStale) state.oddsIncludeStale = Boolean(ui.oddsIncludeStale.checked)
if (ui.oddsIncludeStarted) state.oddsIncludeStarted = Boolean(ui.oddsIncludeStarted.checked)
if (ui.oddsSeenMins) {
  const n = Number(ui.oddsSeenMins.value)
  state.oddsSeenMins = Number.isFinite(n) ? Math.max(0, Math.min(10080, n)) : 180
}

loadOdds()
stats.loadStats()
stats.syncStatsInterval()
