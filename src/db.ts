import { createClient, SupabaseClient } from "@supabase/supabase-js"
import { League, Market, Outcome, Sport, Game } from "./domain"

type WorkerEnv = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }

export function getClient(env: WorkerEnv): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch }
  })
}

export async function upsertSports(db: SupabaseClient, rows: Sport[]) {
  if (!rows.length) return
  await db.from("sports").upsert(rows, { onConflict: "source,external_id" })
}

export async function upsertLeagues(db: SupabaseClient, rows: League[]) {
  if (!rows.length) return
  await db.from("leagues").upsert(rows, { onConflict: "source,external_id" })
}

export async function upsertGames(db: SupabaseClient, rows: Game[]) {
  if (!rows.length) return
  await db.from("games").upsert(rows, { onConflict: "source,external_id" })
}

export async function upsertMarkets(db: SupabaseClient, rows: Market[]) {
  if (!rows.length) return
  await db.from("markets").upsert(rows, { onConflict: "source,external_id" })
}

export async function upsertOutcomes(db: SupabaseClient, rows: Outcome[]) {
  if (!rows.length) return
  await db.from("outcomes").upsert(rows, { onConflict: "market_id,label,handicap" })
}

export async function idMap<T extends { id: number; external_id: string }>(rows: T[]) {
  const map: Record<string, number> = {}
  for (const r of rows) map[r.external_id] = r.id
  return map
}

export async function getSportsIdMap(db: SupabaseClient, source: string, externalIds: string[]) {
  if (!externalIds.length) return {}
  const { data } = await db.from("sports").select("id,external_id").eq("source", source).in("external_id", externalIds)
  const map: Record<string, number> = {}
  for (const r of data ?? []) map[r.external_id] = r.id
  return map
}

export async function getLeaguesIdMap(db: SupabaseClient, source: string, externalIds: string[]) {
  if (!externalIds.length) return {}
  const { data } = await db.from("leagues").select("id,external_id").eq("source", source).in("external_id", externalIds)
  const map: Record<string, number> = {}
  for (const r of data ?? []) map[r.external_id] = r.id
  return map
}

export async function getGamesIdMap(db: SupabaseClient, source: string, externalIds: string[]) {
  if (!externalIds.length) return {}
  const { data } = await db.from("games").select("id,external_id").eq("source", source).in("external_id", externalIds)
  const map: Record<string, number> = {}
  for (const r of data ?? []) map[r.external_id] = r.id
  return map
}

export async function getMarketsIdMap(db: SupabaseClient, source: string, externalIds: string[]) {
  if (!externalIds.length) return {}
  const { data } = await db.from("markets").select("id,external_id").eq("source", source).in("external_id", externalIds)
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
  await db.from("live_meta").upsert(rows, { onConflict: "provider_key" })
}
