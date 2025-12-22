import type { ExecutionContext, ScheduledEvent } from "@cloudflare/workers-types"
import type { Env } from "./env"
import { runLive, runPrematchDiscovery, runPrematchHourly } from "./service"

export async function scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
  if (event.cron === "*/1 * * * *") {
    ctx.waitUntil(Promise.allSettled([
      runLive(env),
      runPrematchDiscovery(env as any, { batch: 5 })
    ]))
  } else if (event.cron === "0 * * * *") {
    ctx.waitUntil(runPrematchHourly(env as any))
  } else if (event.cron === "5 */6 * * *") {
    ctx.waitUntil(runPrematchDiscovery(env as any, { batch: 5 }))
  }
}
