import { getLiveHTML } from "../fetcher"
import { parseLive } from "../parser"
import { persistParsed } from "./persist"

type WorkerEnv = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string; DEFAULT_SPORT_ID?: string }

export async function runLive(env: WorkerEnv) {
  const html = await getLiveHTML()
  const parsed = parseLive(html)
  const res = await persistParsed(env, parsed)
  return res
}
