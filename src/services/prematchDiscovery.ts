import { getSportMatchListHTML } from "../fetcher"
import { parsePrematchSportMatchList } from "../parser"
import { claimScrapeTasks, getClient, updateScrapeTask, upsertScrapeQueue } from "../db"
import { persistParsed } from "./persist"

type WorkerEnv = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string; DEFAULT_SPORT_ID?: string }

const SOURCE = "tounesbet"

export async function runPrematchDiscovery(env: WorkerEnv, opts?: { batch?: number }) {
  const db = getClient(env)
  const sportId = env.DEFAULT_SPORT_ID || "1181"
  const betRangeFilter = "0"
  const lockOwner = `worker:${Math.random().toString(16).slice(2)}`

  const futureCutoffIso = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
  try {
    const unstick = await db
      .from("scrape_queue")
      .update({ not_before_at: null })
      .eq("source", SOURCE)
      .eq("task", "prematch_catalog_page")
      .eq("status", "pending")
      .is("last_success_at", null)
      .gt("not_before_at", futureCutoffIso)
    if (unstick.error) throw new Error(`prematch_catalog_page unstick failed: ${JSON.stringify(unstick.error)}`)
  } catch {
  }

  const EMPTY_STREAK_LIMIT = 8

  const batch = Math.max(1, Math.min(4, Number(opts?.batch ?? 3) || 3))
  let tasks = await claimScrapeTasks(db, SOURCE, "prematch_catalog_page", batch, lockOwner)
  if (!tasks.length) {
    const nowIso = new Date().toISOString()
    const existing = await db
      .from("scrape_queue")
      .select("id")
      .eq("source", SOURCE)
      .eq("task", "prematch_catalog_page")
      .limit(1)
    if (existing.error) throw new Error(`prematch_catalog_page existence check failed: ${JSON.stringify(existing.error)}`)
    if ((existing.data ?? []).length === 0) {
      await upsertScrapeQueue(db, [{
        source: SOURCE,
        task: "prematch_catalog_page",
        external_id: `${sportId}:${betRangeFilter}:1:0`,
        status: "pending",
        priority: 50
      }])
      tasks = await claimScrapeTasks(db, SOURCE, "prematch_catalog_page", batch, lockOwner)
    } else {
      const soonest = await db
        .from("scrape_queue")
        .select("not_before_at")
        .eq("source", SOURCE)
        .eq("task", "prematch_catalog_page")
        .eq("status", "pending")
        .not("not_before_at", "is", null)
        .order("not_before_at", { ascending: true })
        .limit(1)
      if (soonest.error) throw new Error(`prematch_catalog_page min not_before_at check failed: ${JSON.stringify(soonest.error)}`)
      const nb = (soonest.data ?? [])?.[0]?.not_before_at ? String((soonest.data ?? [])?.[0]?.not_before_at) : null
      const nbMs = nb ? Date.parse(nb) : NaN
      const thresholdMs = 2 * 60 * 60 * 1000
      if (Number.isFinite(nbMs) && nbMs - Date.now() > thresholdMs) {
        const upd = await db
          .from("scrape_queue")
          .update({ not_before_at: null, locked_at: null, lock_owner: null, status: "pending" })
          .eq("source", SOURCE)
          .eq("task", "prematch_catalog_page")
          .eq("status", "pending")
          .gt("not_before_at", nowIso)
        if (upd.error) throw new Error(`prematch_catalog_page auto-expedite failed: ${JSON.stringify(upd.error)}`)
        tasks = await claimScrapeTasks(db, SOURCE, "prematch_catalog_page", batch, lockOwner)
      }
    }
  }

  const results: { pages: number; games: number; enqueued1x2: number; nextPagesEnqueued: number; fail: number; processed: { id: number; external_id: string; page: number }[] } = {
    pages: 0,
    games: 0,
    enqueued1x2: 0,
    nextPagesEnqueued: 0,
    fail: 0,
    processed: []
  }
  const tenMinutesLater = () => new Date(Date.now() + 10 * 60 * 1000).toISOString()
  const sixHoursLater = () => new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString()
  const backoffLater = (attempts: number) => new Date(Date.now() + Math.min(60, 5 * Math.max(1, attempts)) * 60 * 1000).toISOString()

  const enqueue1x2: { matchId: string; startTime: string | null }[] = []
  const enqueueNextPages: string[] = []
  const nowIso = () => new Date().toISOString()

  function looksBlocked(html: string): boolean {
    const h = String(html || "")
    if (!h) return true
    if (/Actuellement,\s+il\s+n\x27y\s+a\s+pas\s+de\s+correspondances\s+actives\./i.test(h)) return false
    if (/cloudflare|checking your browser|attention required|cf-ray|cdn-cgi/i.test(h)) return true
    if (/document\.cookie\s*=\s*"[^";=]+=[^;]+\s*;\s*path=\//i.test(h)) return true
    return false
  }

  function hasComplete1x2(game: any) {
    const markets = Array.isArray(game?.markets) ? game.markets : []
    const m = markets.find((x: any) => String(x?.key ?? "").toLowerCase() === "1x2")
    const outs = Array.isArray(m?.outcomes) ? m.outcomes : []
    if (outs.length < 3) return false
    const labels = new Set(outs.map((o: any) => String(o?.label ?? "").toUpperCase().trim()))
    if (!labels.has("1") || !labels.has("X") || !labels.has("2")) return false
    const pricesOk = outs.filter((o: any) => Number.isFinite(Number(o?.price)) && Number(o?.price) > 0).length >= 3
    return pricesOk
  }

  for (const t of tasks) {
    const id = Number(t.id)
    const attempts = Number(t.attempts ?? 0)
    const ext = String(t.external_id ?? "")
    const parts = ext.split(":")
    const page = Number(parts[2] ?? "1")
    const sId = parts[0] || sportId
    const br = parts[1] || betRangeFilter
    const emptyStreak = Number(parts[3] ?? "0")

    try {
      const html = await getSportMatchListHTML(sId, br, page)
      const hasMatchIds = /data-matchid=["']\d+["']/i.test(html) || /matchesTableBody/i.test(html)
      if (!hasMatchIds && looksBlocked(html)) throw new Error("blocked matchlist html")
      const parsed = parsePrematchSportMatchList(html, sId)
      const res = await persistParsed(env, parsed)

      const games = parsed.flatMap(s => s.leagues).flatMap(l => l.games)
      results.pages++
      results.games += res.games
      results.processed.push({ id, external_id: ext, page })

      const nextEmptyStreak = games.length ? 0 : (emptyStreak + 1)

      if (games.length) {
        for (const g of games) {
          if (!hasComplete1x2(g)) enqueue1x2.push({ matchId: String(g.external_id), startTime: g.start_time ? String(g.start_time) : null })
        }
      }

      if (!games.length && nextEmptyStreak >= EMPTY_STREAK_LIMIT) {
      } else {
        const fanout = games.length ? 3 : 1
        for (let k = 1; k <= fanout; k++) {
          const np = page + k
          if (np > 250) break
          enqueueNextPages.push(`${sId}:${br}:${np}:${nextEmptyStreak}`)
        }
      }

      await updateScrapeTask(db, id, {
        status: "pending",
        not_before_at: games.length ? tenMinutesLater() : sixHoursLater(),
        locked_at: null,
        lock_owner: null,
        last_error: null,
        last_success_at: nowIso()
      })
    } catch (e) {
      results.fail++
      try {
        await updateScrapeTask(db, id, {
          status: "pending",
          not_before_at: backoffLater(attempts),
          locked_at: null,
          lock_owner: null,
          last_error: String(e)
        })
      } catch {
      }
    }
  }

  if (enqueue1x2.length) {
    const byId = new Map<string, { matchId: string; startTime: string | null }>()
    for (const e of enqueue1x2) {
      if (!e.matchId) continue
      if (!byId.has(e.matchId)) byId.set(e.matchId, e)
    }
    const uniq = Array.from(byId.values())

    const nowMs = Date.now()
    const rows = uniq.map(({ matchId, startTime }) => {
      let priority = 20
      const ms = startTime ? Date.parse(startTime) : NaN
      if (Number.isFinite(ms)) {
        const diffMins = (ms - nowMs) / 60000
        if (diffMins <= 24 * 60) priority = 5
        else if (diffMins <= 3 * 24 * 60) priority = 10
      }
      return { source: SOURCE, task: "prematch_1x2", external_id: matchId, status: "pending", priority }
    })

    await upsertScrapeQueue(db, rows)
    results.enqueued1x2 += uniq.length
  }

  if (enqueueNextPages.length) {
    const uniq = Array.from(new Set(enqueueNextPages))
    await upsertScrapeQueue(db, uniq.map(external_id => ({
      source: SOURCE,
      task: "prematch_catalog_page",
      external_id,
      status: "pending",
      priority: 20
    })))
    results.nextPagesEnqueued += uniq.length
  }

  return results
}
