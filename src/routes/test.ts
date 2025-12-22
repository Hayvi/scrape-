import type { Env } from "../env"
import { handleTestEnvRoute } from "./test/env"
import { handleTestLiveRoute } from "./test/live"
import { handleTestMatchRoute } from "./test/match"
import { handleTestMatchlistRoutes } from "./test/matchlist"
import { handleTestMatchlistJsRoute } from "./test/matchlistJs"
import { handleTestPrematchRoute } from "./test/prematch"
import { handleTestProbeRoute } from "./test/probe"
import { handleTestQueueRoute } from "./test/queue"
import { handleTestRunRoute } from "./test/run"
import { handleTestSportRoutes } from "./test/sport"
import { handleTestStatsRoute } from "./test/stats"
import { handleTestStatscoreRoute } from "./test/statscore"

export async function handleTestRoutes(request: Request, env: Env, url: URL): Promise<Response | null> {
  const p = url.pathname
  if (request.method !== "GET") return null

  const envRes = await handleTestEnvRoute(request, env, url, p)
  if (envRes) return envRes

  const queueRes = await handleTestQueueRoute(request, env, url, p)
  if (queueRes) return queueRes

  const matchlistRes = await handleTestMatchlistRoutes(request, env, url, p)
  if (matchlistRes) return matchlistRes

  const sportRes = await handleTestSportRoutes(request, env, url, p)
  if (sportRes) return sportRes

  const matchlistJsRes = await handleTestMatchlistJsRoute(request, env, url, p)
  if (matchlistJsRes) return matchlistJsRes

  const runRes = await handleTestRunRoute(request, env, url, p)
  if (runRes) return runRes

  const statsRes = await handleTestStatsRoute(request, env, url, p)
  if (statsRes) return statsRes

  const liveRes = await handleTestLiveRoute(request, env, url, p)
  if (liveRes) return liveRes

  const prematchRes = await handleTestPrematchRoute(request, env, url, p)
  if (prematchRes) return prematchRes

  const probeRes = await handleTestProbeRoute(request, env, url, p)
  if (probeRes) return probeRes

  const statscoreRes = await handleTestStatscoreRoute(request, env, url, p)
  if (statscoreRes) return statscoreRes

  const matchRes = await handleTestMatchRoute(request, env, url, p)
  if (matchRes) return matchRes

  return null
}
