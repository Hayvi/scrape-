export function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } })
}

export function notFound(msg = "Not Found") {
  return json({ error: msg }, 404)
}
