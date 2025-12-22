import { setText } from "./utils.js"

export function createStats(ui) {
  let statsInterval = null

  function statsPath(includeStale) {
    const minsRaw = ui.statsSeenMins ? ui.statsSeenMins.value : "180"
    const mins = Math.max(0, Math.min(10080, Number(minsRaw ?? "180") || 180))
    const params = new URLSearchParams()
    params.set("sportKey", "football")
    params.set("seenWithinMinutes", String(mins))
    if (includeStale) params.set("includeStale", "1")
    return `/api/test/stats?${params.toString()}`
  }

  async function loadStats() {
    setText(ui.statsStamp, "Loading...")
    try {
      const [freshRes, allRes] = await Promise.all([
        fetch(statsPath(false), { headers: { accept: "application/json" } }),
        fetch(statsPath(true), { headers: { accept: "application/json" } }),
      ])

      const freshTxt = await freshRes.text()
      const allTxt = await allRes.text()

      let fresh = null
      let all = null
      try {
        fresh = JSON.parse(freshTxt)
      } catch {
        fresh = { error: freshTxt }
      }
      try {
        all = JSON.parse(allTxt)
      } catch {
        all = { error: allTxt }
      }

      const fUp = fresh?.totals?.games_upcoming_strict
      const fSt = fresh?.totals?.games_started_or_now
      const fT = fresh?.totals?.games

      const aUp = all?.totals?.games_upcoming_strict
      const aSt = all?.totals?.games_started_or_now
      const aT = all?.totals?.games

      setText(ui.statsFreshUpcoming, fUp)
      setText(ui.statsFreshStarted, fSt)
      setText(ui.statsFreshTotal, fT)

      setText(ui.statsAllUpcoming, aUp)
      setText(ui.statsAllStarted, aSt)
      setText(ui.statsAllTotal, aT)

      const delta = typeof aUp === "number" && typeof fUp === "number" ? aUp - fUp : null
      setText(ui.statsDelta, delta)

      const stamp = new Date()
      let stampStr = stamp.toISOString()
      try {
        stampStr = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(stamp)
      } catch {}
      setText(ui.statsStamp, stampStr)
    } catch (e) {
      setText(ui.statsStamp, String(e))
    }
  }

  function syncStatsInterval() {
    if (statsInterval) {
      clearInterval(statsInterval)
      statsInterval = null
    }
    if (ui.statsAuto && ui.statsAuto.checked) {
      statsInterval = setInterval(loadStats, 60 * 1000)
    }
  }

  return { loadStats, syncStatsInterval }
}
