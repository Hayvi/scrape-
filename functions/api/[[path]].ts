export type Env = {
  API_BASE_URL?: string
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context

  const base = String(env.API_BASE_URL ?? "").trim()
  if (!base) {
    return new Response(JSON.stringify({ error: "Missing API_BASE_URL" }), {
      status: 500,
      headers: { "content-type": "application/json" }
    })
  }

  const incomingUrl = new URL(request.url)
  const targetUrl = new URL(incomingUrl.pathname + incomingUrl.search, base)

  const upstreamRes = await fetch(
    targetUrl,
    new Request(targetUrl.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: "manual"
    })
  )

  return upstreamRes
}
