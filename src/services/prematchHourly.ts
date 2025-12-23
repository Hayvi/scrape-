import { claimScrapeTasks, getClient, updateScrapeTask } from "../db"
import { persistMarketsForMatches } from "./persist"
import { fetchMatchMarkets, pick1x2Only } from "./matchMarkets"

type WorkerEnv = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string; DEFAULT_SPORT_ID?: string }

const SOURCE = "tounesbet"

export async function runPrematchHourly(env: WorkerEnv, batch = 12) {
  const db = getClient(env)
  const lockOwner = `worker:${Math.random().toString(16).slice(2)}`
  const safeBatch = Math.max(1, Math.min(8, Number(batch) || 12))
  const tasks = await claimScrapeTasks(db, SOURCE, "prematch_1x2", safeBatch, lockOwner)
  const results: { ok: number; fail: number } = { ok: 0, fail: 0 }
  const oneHourLater = () => new Date(Date.now() + 60 * 60 * 1000).toISOString()
  const backoffLater = (attempts: number) => new Date(Date.now() + Math.min(60, 5 * Math.max(1, attempts)) * 60 * 1000).toISOString()

  const matchIdToMarkets = new Map<string, any[]>()
  const successIds: number[] = []
  const failures: { id: number; attempts: number; error: string }[] = []

  for (const t of tasks) {
    const id = Number(t.id)
    const matchId = String(t.external_id)
    const attempts = Number(t.attempts ?? 0)
    try {
      const markets = await fetchMatchMarkets(matchId)
      const oneX2 = pick1x2Only(markets)
      matchIdToMarkets.set(matchId, oneX2)
      successIds.push(id)
    } catch (e) {
      failures.push({ id, attempts, error: String(e) })
    }
  }

  if (matchIdToMarkets.size) {
    await persistMarketsForMatches(env, matchIdToMarkets)
  }

  if (successIds.length) {
    const next = oneHourLater()
    const now = new Date().toISOString()
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
      .in("id", successIds)
    if (upd.error) throw new Error(`updateScrapeTask batch failed: ${JSON.stringify(upd.error)}`)
    results.ok += successIds.length
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
    results.fail++
  }

  return results
}
