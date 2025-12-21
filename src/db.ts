import { createClient, SupabaseClient } from "@supabase/supabase-js"
import { League, Market, Outcome, Sport, Game } from "./domain"

type WorkerEnv = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }

export function getClient(env: WorkerEnv): SupabaseClient {
  const raw = String(env.SUPABASE_URL ?? "").trim()
  if (!raw) throw new Error("SUPABASE_URL is missing")
  if (!/^https?:\/\//i.test(raw)) throw new Error("SUPABASE_URL must start with http:// or https://")
  try {
    new URL(raw)
  } catch {
    throw new Error("SUPABASE_URL is not a valid URL")
  }

  return createClient(raw, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch }
  })
}

export async function upsertSports(db: SupabaseClient, rows: Sport[]) {
  if (!rows.length) return
  const { error } = await db.from("sports").upsert(rows, { onConflict: "source,external_id" })
  if (error) throw new Error(`upsertSports failed: ${JSON.stringify(error)}`)
}

export async function upsertLeagues(db: SupabaseClient, rows: League[]) {
  if (!rows.length) return
  const { error } = await db.from("leagues").upsert(rows, { onConflict: "source,external_id" })
  if (error) throw new Error(`upsertLeagues failed: ${JSON.stringify(error)}`)
}

export async function upsertGames(db: SupabaseClient, rows: Game[]) {
  if (!rows.length) return
  const { error } = await db.from("games").upsert(rows, { onConflict: "source,external_id" })
  if (error) throw new Error(`upsertGames failed: ${JSON.stringify(error)}`)
}

export async function upsertMarkets(db: SupabaseClient, rows: Market[]) {
  if (!rows.length) return
  const { error } = await db.from("markets").upsert(rows, { onConflict: "source,external_id" })
  if (error) throw new Error(`upsertMarkets failed: ${JSON.stringify(error)}`)
}

export async function upsertOutcomes(db: SupabaseClient, rows: Outcome[]) {
  if (!rows.length) return
  const { error } = await db.from("outcomes").upsert(rows, { onConflict: "market_id,label,handicap" })
  if (error) throw new Error(`upsertOutcomes failed: ${JSON.stringify(error)}`)
}

export async function idMap<T extends { id: number; external_id: string }>(rows: T[]) {
  const map: Record<string, number> = {}
  for (const r of rows) map[r.external_id] = r.id
  return map
}

export async function getSportsIdMap(db: SupabaseClient, source: string, externalIds: string[]) {
  if (!externalIds.length) return {}
  const { data, error } = await db.from("sports").select("id,external_id").eq("source", source).in("external_id", externalIds)
  if (error) throw new Error(`getSportsIdMap failed: ${JSON.stringify(error)}`)
  const map: Record<string, number> = {}
  for (const r of data ?? []) map[r.external_id] = r.id
  return map
}

export async function getLeaguesIdMap(db: SupabaseClient, source: string, externalIds: string[]) {
  if (!externalIds.length) return {}
  const { data, error } = await db.from("leagues").select("id,external_id").eq("source", source).in("external_id", externalIds)
  if (error) throw new Error(`getLeaguesIdMap failed: ${JSON.stringify(error)}`)
  const map: Record<string, number> = {}
  for (const r of data ?? []) map[r.external_id] = r.id
  return map
}

export async function getGamesIdMap(db: SupabaseClient, source: string, externalIds: string[]) {
  if (!externalIds.length) return {}
  const { data, error } = await db.from("games").select("id,external_id").eq("source", source).in("external_id", externalIds)
  if (error) throw new Error(`getGamesIdMap failed: ${JSON.stringify(error)}`)
  const map: Record<string, number> = {}
  for (const r of data ?? []) map[r.external_id] = r.id
  return map
}

export async function getMarketsIdMap(db: SupabaseClient, source: string, externalIds: string[]) {
  if (!externalIds.length) return {}
  const { data, error } = await db.from("markets").select("id,external_id").eq("source", source).in("external_id", externalIds)
  if (error) throw new Error(`getMarketsIdMap failed: ${JSON.stringify(error)}`)
  const map: Record<string, number> = {}
  for (const r of data ?? []) map[r.external_id] = r.id
  return map
}

type LiveMetaRow = {
  provider_key: string
  provider: string
  provider_ls_id?: string | null
  provider_event_id?: string | null
  status_name?: string | null
  clock_time?: number | null
  start_time?: string | null
  home_team?: string | null
  away_team?: string | null
  home_score?: number | null
  away_score?: number | null
  competition_name?: string | null
}

export async function upsertLiveMeta(db: SupabaseClient, rows: LiveMetaRow[]) {
  if (!rows.length) return
  const { error } = await db.from("live_meta").upsert(rows, { onConflict: "provider_key" })
  if (error) throw new Error(`upsertLiveMeta failed: ${JSON.stringify(error)}`)
}
