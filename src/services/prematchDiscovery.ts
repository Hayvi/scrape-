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

  const batch = Math.max(1, Math.min(5, Number(opts?.batch ?? 3) || 3))
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
  const oneHourLater = () => new Date(Date.now() + 60 * 60 * 1000).toISOString()
  const sixHoursLater = () => new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString()
  const backoffLater = (attempts: number) => new Date(Date.now() + Math.min(60, 5 * Math.max(1, attempts)) * 60 * 1000).toISOString()

  const enqueue1x2Ids: string[] = []
  const enqueueNextPages: string[] = []
  const successIds: number[] = []
  const emptySuccessIds: number[] = []
  const failures: { id: number; attempts: number; error: string }[] = []

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
      const parsed = parsePrematchSportMatchList(html, sId)
      const res = await persistParsed(env, parsed)

      const games = parsed.flatMap(s => s.leagues).flatMap(l => l.games)
      results.pages++
      results.games += res.games
      results.processed.push({ id, external_id: ext, page })

      const nextEmptyStreak = games.length ? 0 : (emptyStreak + 1)

      if (games.length) {
        for (const g of games) enqueue1x2Ids.push(String(g.external_id))
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

      successIds.push(id)
      if (!games.length) emptySuccessIds.push(id)
    } catch (e) {
      results.fail++
      failures.push({ id, attempts, error: String(e) })
    }
  }

  if (enqueue1x2Ids.length) {
    const uniq = Array.from(new Set(enqueue1x2Ids))
    await upsertScrapeQueue(db, uniq.map(external_id => ({
      source: SOURCE,
      task: "prematch_1x2",
      external_id,
      status: "pending",
      priority: 10
    })))
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

  if (successIds.length) {
    const next = oneHourLater()
    const nextEmpty = sixHoursLater()
    const now = new Date().toISOString()

    const normalIds = successIds.filter(x => !emptySuccessIds.includes(x))

    if (normalIds.length) {
      const upd = await db
        .from("scrape_queue")
        .update({
          status: "pending",
          not_before_at: next,
          locked_at: null,
          lock_owner: null,
          last_error: null,
          last_success_at: now
        })
        .in("id", normalIds)
      if (upd.error) throw new Error(`updateScrapeTask batch failed: ${JSON.stringify(upd.error)}`)
    }

    if (emptySuccessIds.length) {
      const updEmpty = await db
        .from("scrape_queue")
        .update({
          status: "pending",
          not_before_at: nextEmpty,
          locked_at: null,
          lock_owner: null,
          last_error: null,
          last_success_at: now
        })
        .in("id", emptySuccessIds)
      if (updEmpty.error) throw new Error(`updateScrapeTask empty batch failed: ${JSON.stringify(updEmpty.error)}`)
    }
  }

  for (const f of failures) {
    try {
      await updateScrapeTask(db, f.id, {
        status: "pending",
        not_before_at: backoffLater(f.attempts),
        locked_at: null,
        lock_owner: null,
        last_error: f.error
      })
    } catch {
    }
  }

  return results
}
