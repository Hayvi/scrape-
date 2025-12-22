import { getClient, upsertLiveMeta } from "../../db"
import type { Env } from "../../env"
import { json } from "../../http/response"
import { getStatscoreSSR, parseStatscoreSSR } from "../../statscore"

export async function handleTestStatscoreRoute(_request: Request, env: Env, url: URL, p: string): Promise<Response | null> {
  if (!p.startsWith("/api/test/statscore/")) return null

  const raw = decodeURIComponent(p.slice("/api/test/statscore/".length))
  const lsId = raw.startsWith("m:") ? raw.slice(2) : raw
  const wg = url.searchParams.get("wg") ?? "65c592e745164675a446d35b"
  const tz = url.searchParams.get("tz") ?? "0"
  const persist = url.searchParams.get("persist") === "1"
  try {
    const payload = await getStatscoreSSR(lsId, wg, "en", tz)
    const meta = parseStatscoreSSR(payload, lsId)
    let persisted = false
    if (persist) {
      const db = getClient(env)
      const provider_key = `statscore:ls:${lsId}`
      await upsertLiveMeta(db, [{
        provider_key,
        provider: "statscore",
        provider_ls_id: meta.provider_ls_id,
        provider_event_id: meta.provider_event_id,
        status_name: meta.status_name,
        clock_time: meta.clock_time ?? null,
        start_time: meta.start_time ?? null,
        home_team: meta.home_team ?? null,
        away_team: meta.away_team ?? null,
        home_score: meta.home_score ?? null,
        away_score: meta.away_score ?? null,
        competition_name: meta.competition_name ?? null
      }])
      persisted = true
    }
    return json({ lsId, widgetGroup: wg, timezone: tz, meta, persisted })
  } catch (e) {
    return json({ error: String(e) }, 500)
  }
}
