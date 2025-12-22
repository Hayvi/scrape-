import type { ExecutionContext, ScheduledEvent } from "@cloudflare/workers-types"
import type { Env } from "./env"
export type { Env } from "./env"
import { json, notFound } from "./http/response"
import { serveOdds } from "./http/serveOdds"
import { handleTestRoutes } from "./routes/test"
import { scheduled as scheduledHandler } from "./scheduler"
import { servePrematchFullMarkets } from "./service"

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const p = url.pathname

    if (request.method === "GET") {
      const testResponse = await handleTestRoutes(request, env, url)
      if (testResponse) return testResponse

      if (p.startsWith("/api/odds/prematch/")) {
        const sportKey = decodeURIComponent(p.slice("/api/odds/prematch/".length))
        try {
          return await serveOdds(env, url, sportKey, false)
        } catch (e) {
          return json({ error: String(e) }, 500)
        }
      }

      if (p.startsWith("/api/odds/live/")) {
        const sportKey = decodeURIComponent(p.slice("/api/odds/live/".length))
        try {
          return await serveOdds(env, url, sportKey, true)
        } catch (e) {
          return json({ error: String(e) }, 500)
        }
      }

      if (p.startsWith("/api/prematch/match/") && p.endsWith("/markets")) {
        const matchId = decodeURIComponent(p.slice("/api/prematch/match/".length, -"/markets".length))
        const fresh = url.searchParams.get("fresh") === "1"
        try {
          const data = await servePrematchFullMarkets(env as any, matchId, fresh)
          return json(data)
        } catch (e) {
          const msg = String(e)
          if (msg.includes("not_found:game")) {
            return json({ error: "match not in DB yet", matchId }, 404)
          }
          return json({ error: msg }, 500)
        }
      }
    }

    return notFound()
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    return scheduledHandler(event, env, ctx)
  }
}
