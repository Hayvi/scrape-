import { getClient, updateScrapeTask, upsertScrapeQueue } from "../db"
import { persistMarketsForMatch } from "./persist"
import { fetchMatchMarkets } from "./matchMarkets"

type WorkerEnv = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string; DEFAULT_SPORT_ID?: string }

const SOURCE = "tounesbet"

export async function servePrematchFullMarkets(env: WorkerEnv, matchId: string, forceFresh: boolean) {
  const db = getClient(env)
  const ttlMs = 60 * 60 * 1000
  const g = await db
    .from("games")
    .select("id")
    .eq("source", SOURCE)
    .eq("external_id", matchId)
    .maybeSingle()
  if (!g.data?.id) throw new Error("not_found:game")

  const row = await db
    .from("scrape_queue")
    .select("id,last_success_at")
    .eq("source", SOURCE)
    .eq("task", "prematch_full_markets")
    .eq("external_id", matchId)
    .maybeSingle()

  const last = row.data?.last_success_at ? Date.parse(String(row.data.last_success_at)) : 0
  const fresh = last > 0 && Date.now() - last < ttlMs
  if (!forceFresh && fresh) {
    const marketsRes = await db.from("markets").select("id,game_id,key,name").eq("game_id", g.data.id)
    const marketsData = (marketsRes.data ?? []) as { id: number; game_id: number; key: string; name: string }[]
    const marketIds = marketsData.map(m => m.id)
    const outsRes = marketIds.length ? await db.from("outcomes").select("id,market_id,label,price,handicap").in("market_id", marketIds) : { data: [] as any[] }
    const outs = (outsRes.data ?? []) as { id: number; market_id: number; label: string; price: number; handicap: number | null }[]
    const byMarket = new Map<number, any[]>()
    for (const m of marketsData) byMarket.set(m.id, [])
    for (const o of outs) (byMarket.get(o.market_id) ?? []).push({ id: o.id, label: o.label, price: o.price, handicap: o.handicap })
    return {
      matchId,
      cached: true,
      last_success_at: row.data?.last_success_at ?? null,
      markets: marketsData.map(m => ({ id: m.id, key: m.key, name: m.name, outcomes: byMarket.get(m.id) ?? [] }))
    }
  }

  await upsertScrapeQueue(db, [{
    source: SOURCE,
    task: "prematch_full_markets",
    external_id: matchId,
    status: "pending",
    priority: 5
  }])

  const markets = await fetchMatchMarkets(matchId)
  await persistMarketsForMatch(env, matchId, markets)
  const next = new Date(Date.now() + ttlMs).toISOString()
  if (row.data?.id) {
    await updateScrapeTask(db, Number(row.data.id), {
      status: "pending",
      not_before_at: next,
      locked_at: null,
      lock_owner: null,
      last_error: null,
      last_success_at: new Date().toISOString()
    })
  } else {
    const claimed = await db
      .from("scrape_queue")
      .select("id")
      .eq("source", SOURCE)
      .eq("task", "prematch_full_markets")
      .eq("external_id", matchId)
      .maybeSingle()
    if (claimed.data?.id) {
      await updateScrapeTask(db, Number(claimed.data.id), {
        status: "pending",
        not_before_at: next,
        locked_at: null,
        lock_owner: null,
        last_error: null,
        last_success_at: new Date().toISOString()
      })
    }
  }

  return { matchId, cached: false, markets }
}
