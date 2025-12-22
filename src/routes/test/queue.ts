import { claimScrapeTasks, getClient, upsertScrapeQueue } from "../../db"
import type { Env } from "../../env"
import { json } from "../../http/response"

export async function handleTestQueueRoute(_request: Request, env: Env, url: URL, p: string): Promise<Response | null> {
  if (p !== "/api/test/queue") return null

  const db = getClient(env)
  const action = (url.searchParams.get("action") ?? "ping").toLowerCase()
  const source = url.searchParams.get("source") ?? "tounesbet"
  const task = url.searchParams.get("task") ?? "prematch_1x2"
  const externalId = url.searchParams.get("externalId") ?? ""
  const limit = Math.max(0, Math.min(50, Number(url.searchParams.get("limit") ?? "5") || 5))
  const lockOwner = url.searchParams.get("lockOwner") ?? "debug"
  try {
    if (action === "enqueue") {
      if (!externalId) return json({ error: "missing externalId" }, 400)
      await upsertScrapeQueue(db, [{ source, task, external_id: externalId, status: "pending", priority: 1 }])
      return json({ ok: true, action, source, task, externalId })
    }
    if (action === "expedite") {
      const upd = await db
        .from("scrape_queue")
        .update({ status: "pending", not_before_at: null, locked_at: null, lock_owner: null })
        .eq("source", source)
        .eq("task", task)
        .select("id")
      if (upd.error) return json({ error: JSON.stringify(upd.error), action, source, task }, 500)
      return json({ ok: true, action, source, task, updated: upd.count ?? null, sampleIds: (upd.data ?? []).slice(0, 20).map((r: any) => r.id) })
    }
    if (action === "peek") {
      const q = await db
        .from("scrape_queue")
        .select("id,source,task,external_id,status,priority,not_before_at,locked_at,lock_owner,attempts,last_error,last_success_at,created_at,updated_at")
        .eq("source", source)
        .eq("task", task)
        .order("priority", { ascending: false })
        .order("created_at", { ascending: true })
        .limit(limit)
      return json({ ok: true, action, source, task, limit, rows: q.data ?? [], error: q.error ? JSON.stringify(q.error) : null })
    }
    if (action === "release") {
      const idRaw = url.searchParams.get("id")
      const id = idRaw ? Number(idRaw) : NaN
      if (!Number.isFinite(id)) return json({ error: "missing id" }, 400)
      const { error } = await db.from("scrape_queue").update({ status: "pending", locked_at: null, lock_owner: null }).eq("id", id)
      if (error) return json({ error: JSON.stringify(error) }, 500)
      return json({ ok: true, action, id })
    }
    if (action === "claim") {
      const claimed = await claimScrapeTasks(db, source, task, limit, lockOwner)
      return json({ ok: true, action, source, task, limit, claimed })
    }
    const ping = await claimScrapeTasks(db, source, task, 0, lockOwner)
    return json({ ok: true, action: "ping", source, task, rpc: "claim_scrape_tasks", resultCount: ping.length })
  } catch (e) {
    return json({ error: String(e), action, source, task }, 500)
  }
}
