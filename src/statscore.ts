import { fetchWithRetry } from "./fetcher"
import { LiveMeta } from "./domain"

function buildSSRUrl(lsId: string, widgetGroupId: string, language = "en", timezone = "0") {
  const base = `https://widgets.statscore.com/api/ssr/render-widget-group/${encodeURIComponent(widgetGroupId)}`
  const inputData = {
    eventId: `m:${lsId}`,
    language,
    timezone
  }
  const qs = new URLSearchParams({ inputData: JSON.stringify(inputData) })
  return `${base}?${qs.toString()}`
}

export async function getStatscoreSSR(lsId: string, widgetGroupId: string, language = "en", timezone = "0"): Promise<any> {
  const url = buildSSRUrl(lsId, widgetGroupId, language, timezone)
  const res = await fetchWithRetry(url, { headers: { accept: "application/json" } })
  return await res.json()
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
}

export function parseStatscoreSSR(payload: any, lsId: string): LiveMeta {
  const html: string = String(payload?.html ?? "")
  const startMatch = html.match(/<time[^>]*class=["'][^"']*competitionInfoBar__eventStartDate[^"']*["'][^>]*datetime=["']([^"']+)["']/i)
  const start_time = startMatch ? startMatch[1] : null

  let competition_name: string | null = null
  const compM = html.match(/<div[^>]*class=["']STATSCOREWidget--competitionInfoBar__competitionInfo["'][^>]*>\s*([\s\S]*?)<\/div>/i)
  if (compM) competition_name = decodeEntities(compM[1].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim())

  // Try to extract team names from scoreboard
  let home_team: string | null = null
  let away_team: string | null = null
  const homeM = html.match(/class=["'][^"']*scoreboard[^"']*["'][\s\S]*?class=["'][^"']*(home|left)[^"']*team[^"']*name[^"']*["'][^>]*>\s*([^<]+)\s*</i)
  const awayM = html.match(/class=["'][^"']*scoreboard[^"']*["'][\s\S]*?class=["'][^"']*(away|right)[^"']*team[^"']*name[^"']*["'][^>]*>\s*([^<]+)\s*</i)
  if (homeM) home_team = decodeEntities(homeM[2].trim())
  if (awayM) away_team = decodeEntities(awayM[2].trim())

  // Try to extract a textual status label (best-effort)
  let status_name: string | null = null
  const statusM = html.match(/>(1st half|2nd half|Half time|Full time|Kick off|Live)\s*<\/i)
  if (statusM) status_name = statusM[1]

  // Try to extract simple scoreboard numbers
  let home_score: number | null = null
  let away_score: number | null = null
  const scoreM = html.match(/class=["'][^"']*scoreboard[^"']*["'][\s\S]*?class=["'][^"']*score[^"']*["'][^>]*>\s*(\d+)\s*:\s*(\d+)\s*</i)
  if (scoreM) {
    home_score = Number(scoreM[1])
    away_score = Number(scoreM[2])
  }

  const meta: LiveMeta = {
    provider: "statscore",
    provider_ls_id: String(lsId),
    provider_event_id: payload?.state?.event?.id ? String(payload.state.event.id) : null,
    status_name,
    clock_time: payload?.state?.event?.clock_time ?? null,
    start_time,
    home_team,
    away_team,
    home_score,
    away_score,
    competition_name
  }
  return meta
}
