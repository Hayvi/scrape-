import type { Env } from "../../env"
import { json } from "../../http/response"
import { runPrematchDiscovery, runPrematchHourly } from "../../service"

export async function handleTestRunRoute(_request: Request, env: Env, url: URL, p: string): Promise<Response | null> {
  if (p === "/api/test/run/prematch_hourly") {
    const batch = Math.max(1, Math.min(100, Number(url.searchParams.get("batch") ?? "40") || 40))
    try {
      const res = await runPrematchHourly(env as any, batch)
      return json({ ok: true, batch, res })
    } catch (e) {
      return json({ error: String(e) }, 500)
    }
  }

  if (p === "/api/test/run/prematch_discovery") {
    try {
      const batch = Math.max(1, Math.min(8, Number(url.searchParams.get("batch") ?? "3") || 3))
      const res = await runPrematchDiscovery(env as any, { batch })
      return json({ ok: true, batch, res })
    } catch (e) {
      return json({ ok: false, error: String(e) }, 200)
    }
  }

  return null
}
