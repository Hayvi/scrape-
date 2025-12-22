import type { Env } from "../../env"
import { json } from "../../http/response"
import { safeBool } from "../../http/utils"

export async function handleTestEnvRoute(_request: Request, env: Env, _url: URL, p: string): Promise<Response | null> {
  if (p !== "/api/test/env") return null

  const rawUrl = String(env.SUPABASE_URL ?? "")
  const trimmed = rawUrl.trim()
  let urlValid = false
  let urlHost: string | null = null
  let urlProtocol: string | null = null
  if (trimmed && /^https?:\/\//i.test(trimmed)) {
    try {
      const u = new URL(trimmed)
      urlValid = true
      urlHost = u.host
      urlProtocol = u.protocol
    } catch {
      urlValid = false
    }
  }
  return json({
    supabase: {
      urlPresent: safeBool(env.SUPABASE_URL),
      urlTrimmedLength: trimmed.length,
      urlValid,
      urlHost,
      urlProtocol,
      serviceRoleKeyPresent: safeBool(env.SUPABASE_SERVICE_ROLE_KEY)
    },
    worker: {
      defaultSportId: env.DEFAULT_SPORT_ID ?? null
    }
  })
}
