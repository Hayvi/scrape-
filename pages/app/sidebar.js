import { has1x2Odds } from "./utils.js"

export function renderSidebar(ui, state, render) {
  const allLeagues = state.data?.leagues ?? []
  ui.leagueList.innerHTML = ""

  if (!allLeagues.length) {
    ui.leagueList.innerHTML = `<div class="pill">No leagues</div>`
    return
  }

  const search = String(state.leagueSearch ?? "").trim().toLowerCase()

  function splitName(full) {
    const s = String(full ?? "").trim()
    const parts = s.split("/")
    if (parts.length >= 2) {
      const country = parts[0].trim() || "Other"
      const league = parts.slice(1).join("/").trim() || s
      return { country, league }
    }
    return { country: s || "Other", league: s || "League" }
  }

  function leagueMatchesSearch(league) {
    if (!search) return true
    const rawName = String(league?.name ?? "")
    const name = rawName.toLowerCase()
    if (name.includes(search)) return true

    const parts = splitName(rawName)
    const countryLc = String(parts.country ?? "").toLowerCase()
    const leagueLc = String(parts.league ?? "").toLowerCase()
    if (countryLc.includes(search) || leagueLc.includes(search)) return true

    const games = Array.isArray(league?.games) ? league.games : []
    for (const g of games) {
      const h = String(g.homeTeam ?? "").toLowerCase()
      const a = String(g.awayTeam ?? "").toLowerCase()
      if (h.includes(search) || a.includes(search)) return true
    }
    return false
  }

  function flagFor(country) {
    const c = String(country ?? "").toLowerCase().trim()
    if (c.includes("angleterre") || c.includes("england")) return "🏴"
    if (c.includes("france")) return "🇫🇷"
    if (c.includes("allemagne") || c.includes("germany")) return "🇩🇪"
    if (c.includes("espagne") || c.includes("spain")) return "🇪🇸"
    if (c.includes("italie") || c.includes("italy")) return "🇮🇹"
    if (c.includes("portugal")) return "🇵🇹"
    if (c.includes("monde") || c.includes("world")) return "🌍"
    if (c.includes("tunisie") || c.includes("tunisia")) return "🇹🇳"
    if (c.includes("maroc") || c.includes("morocco")) return "🇲🇦"
    if (c.includes("alg") || c.includes("alger")) return "🇩🇿"
    return "🏳️"
  }

  const leagues = search ? allLeagues.filter(leagueMatchesSearch) : allLeagues

  if (!leagues.length) {
    ui.leagueList.innerHTML = `<div class="pill">No competitions or games match "${search}"</div>`
    return
  }

  const groups = []
  const byCountry = new Map()
  for (const l of leagues) {
    const parts = splitName(l.name)
    if (!byCountry.has(parts.country)) {
      const entry = { country: parts.country, leagues: [] }
      byCountry.set(parts.country, entry)
      groups.push(entry)
    }
    byCountry.get(parts.country).leagues.push({ ...l, __leagueLabel: parts.league })
  }

  function leagueCount(league) {
    const games = Array.isArray(league?.games) ? league.games : []
    const priced = games.reduce((a, game) => a + (has1x2Odds(game) ? 1 : 0), 0)
    return state.onlyWithOdds ? priced : games.length
  }

  function countryCount(group) {
    return group.leagues.reduce((acc, l) => acc + leagueCount(l), 0)
  }

  const visibleGroups = state.hideEmptyCompetitions ? groups.filter((g) => countryCount(g) > 0) : groups

  const visibleLeagueIds = new Set()
  for (const g of visibleGroups) {
    const ls = state.hideEmptyCompetitions ? g.leagues.filter((l) => leagueCount(l) > 0) : g.leagues
    for (const l of ls) visibleLeagueIds.add(String(l.id))
  }
  if (state.hideEmptyCompetitions && state.selectedLeagueId != null && !visibleLeagueIds.has(String(state.selectedLeagueId))) {
    state.selectedLeagueId = null
  }

  const selected = leagues.find((l) => String(l.id) === String(state.selectedLeagueId)) ?? null
  const selectedCountry = selected ? splitName(selected.name).country : null
  if (selectedCountry && state.expandedCountries[selectedCountry] == null) {
    state.expandedCountries[selectedCountry] = true
  }
  if (!selectedCountry && visibleGroups.length === 1 && state.expandedCountries[visibleGroups[0].country] == null) {
    state.expandedCountries[visibleGroups[0].country] = true
  }

  for (const g of visibleGroups) {
    const open = Boolean(state.expandedCountries[g.country])

    const totalCount = countryCount(g)
    if (state.hideEmptyCompetitions && totalCount <= 0) continue

    const cBtn = document.createElement("button")
    cBtn.type = "button"
    cBtn.className = "country-item"
    cBtn.innerHTML = `
            <span class="country-left">
              <span class="country-flag">${flagFor(g.country)}</span>
              <span class="country-name" title="${String(g.country)}">${String(g.country)}</span>
            </span>
            <span class="country-right">
              <span class="nav-count">${totalCount}</span>
              <span class="country-caret">${open ? "▾" : "▸"}</span>
            </span>
          `
    cBtn.addEventListener("click", () => {
      state.expandedCountries[g.country] = !open
      render()
    })
    ui.leagueList.appendChild(cBtn)

    if (open) {
      const wrap = document.createElement("div")
      wrap.className = "league-sublist"
      const leagueList = state.hideEmptyCompetitions ? g.leagues.filter((l) => leagueCount(l) > 0) : g.leagues
      for (const l of leagueList) {
        const btn = document.createElement("button")
        btn.type = "button"
        const active = String(l.id) === String(state.selectedLeagueId)
        btn.className = `league-item ${active ? "league-item-active" : ""}`
        const count = leagueCount(l)
        btn.innerHTML = `
                <span class="nav-left">
                  <span class="nav-dot"></span>
                  <span class="nav-name" title="${String(l.name ?? "")}">${String(l.__leagueLabel ?? l.name ?? "League")}</span>
                </span>
                <span class="nav-count">${count}</span>
              `
        btn.addEventListener("click", (e) => {
          e.stopPropagation()
          state.selectedLeagueId = l.id
          render()
        })
        wrap.appendChild(btn)
      }
      ui.leagueList.appendChild(wrap)
    }
  }
}
