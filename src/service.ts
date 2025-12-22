import { getLiveHTML, getNextMatchesHTML, getPopularMatchesHTML, getSportHTML, getSportMatchListHTML, getTextWithDdosBypassDetailed } from "./fetcher"
import { getSelectedSportIdFromNav, parseLive, parseMatchOddsGrouped, parsePopularMatchesFragment, parsePrematch, parsePrematchNextMatches, parsePrematchSportMatchList } from "./parser"
import { Game, League, Market, Outcome, ParsedSport, Sport } from "./domain"
import { claimScrapeTasks, getClient, getGamesIdMap, getLeaguesIdMap, getMarketsIdMap, getSportsIdMap, updateScrapeTask, upsertGames, upsertLeagues, upsertMarkets, upsertOutcomes, upsertScrapeQueue, upsertSports } from "./db"

type WorkerEnv = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string; DEFAULT_SPORT_ID?: string }

const SOURCE = "tounesbet"

function capMarkets(markets: any[], maxMarkets = 60, maxOutcomes = 16) {
  const ms = markets.slice(0, maxMarkets)
  for (const m of ms) {
    if (Array.isArray(m?.outcomes)) m.outcomes = m.outcomes.slice(0, maxOutcomes)
  }
  return ms
}

function uniqBy<T, K>(arr: T[], key: (v: T) => K): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const v of arr) {
    const k = JSON.stringify(key(v))
    if (seen.has(k)) continue
    seen.add(k)
    out.push(v)
  }
  return out
}

function mapParsed(parsed: ParsedSport[]): { sports: Sport[]; leagues: League[]; games: Game[]; markets: Market[]; outcomes: Outcome[] } {
  const sports: Sport[] = []
  const leagues: League[] = []
  const games: Game[] = []
  const markets: Market[] = []
  const outcomes: Outcome[] = []

  const seenNow = new Date().toISOString()

  for (const s of parsed) {
    sports.push({ source: SOURCE, external_id: s.external_id, key: s.key, name: s.name })
    for (const l of s.leagues) {
      leagues.push({ source: SOURCE, external_id: l.external_id, name: l.name })
      for (const g of l.games) {
        games.push({ source: SOURCE, external_id: g.external_id, home_team: g.home_team, away_team: g.away_team, start_time: new Date(g.start_time).toISOString(), last_seen_at: seenNow, live: g.live })
        for (const m of g.markets) {
          markets.push({ source: SOURCE, external_id: m.external_id, key: m.key, name: m.name })
          for (const o of m.outcomes) {
            outcomes.push({ source: SOURCE, external_id: o.external_id, label: o.label, price: o.price, handicap: o.handicap })
          }
        }
      }
    }
  }

  return { sports: uniqBy(sports, x => [x.source, x.external_id]), leagues: uniqBy(leagues, x => [x.source, x.external_id]), games: uniqBy(games, x => [x.source, x.external_id]), markets: uniqBy(markets, x => [x.source, x.external_id]), outcomes }
}

export async function persistParsed(env: WorkerEnv, parsed: ParsedSport[]): Promise<{ games: number }> {
  const db = getClient(env)
  const { sports, leagues, games, markets, outcomes } = mapParsed(parsed)

  await upsertSports(db, sports)
  const sportIdMap = await getSportsIdMap(db, SOURCE, sports.map(s => s.external_id))

  for (let i = 0; i < leagues.length; i++) {
    const sExt = parsed.find(ps => ps.leagues.some(pl => pl.external_id === leagues[i].external_id))?.external_id
    if (sExt && sportIdMap[sExt]) leagues[i].sport_id = sportIdMap[sExt]
  }
  await upsertLeagues(db, leagues)
  const leagueIdMap = await getLeaguesIdMap(db, SOURCE, leagues.map(l => l.external_id))

  for (let i = 0; i < games.length; i++) {
    const lExt = parsed.flatMap(ps => ps.leagues).find(pl => pl.games.some(pg => pg.external_id === games[i].external_id))?.external_id
    if (lExt && leagueIdMap[lExt]) games[i].league_id = leagueIdMap[lExt]
  }
  await upsertGames(db, games)
  const gameIdMap = await getGamesIdMap(db, SOURCE, games.map(g => g.external_id))

  for (let i = 0; i < markets.length; i++) {
    const gExt = parsed.flatMap(ps => ps.leagues).flatMap(pl => pl.games).find(pg => pg.markets.some(pm => pm.external_id === markets[i].external_id))?.external_id
    if (gExt && gameIdMap[gExt]) markets[i].game_id = gameIdMap[gExt]
  }
  await upsertMarkets(db, markets)
  const marketIdMap = await getMarketsIdMap(db, SOURCE, markets.map(m => m.external_id))

  const outcomeToMarketExt = new Map<string, string>()
  for (const ps of parsed) {
    for (const pl of ps.leagues) {
      for (const pg of pl.games) {
        for (const pm of pg.markets) {
          for (const po of pm.outcomes) {
            if (!outcomeToMarketExt.has(po.external_id)) outcomeToMarketExt.set(po.external_id, pm.external_id)
          }
        }
      }
    }
  }

  for (let i = 0; i < outcomes.length; i++) {
    const mExt = outcomeToMarketExt.get(outcomes[i].external_id)
    if (mExt && marketIdMap[mExt]) outcomes[i].market_id = marketIdMap[mExt]
  }
  const outcomesWithMarket = outcomes.filter(o => typeof o.market_id === "number")
  const outcomesDeduped = uniqBy(outcomesWithMarket, o => [o.market_id, o.label, o.handicap])
  await upsertOutcomes(db, outcomesDeduped)

  return { games: games.length }
}

function pick1x2Only(markets: any[]) {
  const arr = Array.isArray(markets) ? markets : []
  const m = arr.find(x => String(x?.key ?? "").toLowerCase() === "1x2")
    ?? arr.find(x => String(x?.name ?? "").toLowerCase().includes("1x2"))
  return m ? [m] : []
}

async function persistMarketsForMatches(env: WorkerEnv, matchIdToMarkets: Map<string, any[]>) {
  const db = getClient(env)
  const matchIds = [...matchIdToMarkets.keys()]
  if (!matchIds.length) return

  const gamesRes = await db
    .from("games")
    .select("id,external_id")
    .eq("source", SOURCE)
    .in("external_id", matchIds)

  if (gamesRes.error) throw new Error(`games select failed: ${JSON.stringify(gamesRes.error)}`)
  const gameIdByExt: Record<string, number> = {}
  for (const r of gamesRes.data ?? []) gameIdByExt[String(r.external_id)] = Number(r.id)

  const marketRows: Market[] = []
  const outcomeRows: (Outcome & { __market_ext?: string })[] = []

  for (const [matchId, markets] of matchIdToMarkets.entries()) {
    const gameId = gameIdByExt[matchId]
    if (!gameId) continue

    const ms = Array.isArray(markets) ? markets : []
    for (const m of ms) {
      const mExt = String(m?.external_id ?? "")
      if (!mExt) continue
      marketRows.push({
        source: SOURCE,
        external_id: mExt,
        key: String(m?.key ?? "other"),
        name: String(m?.name ?? "Market"),
        game_id: gameId
      })

      const outs = Array.isArray(m?.outcomes) ? m.outcomes : []
      for (const o of outs) {
        const oExt = String(o?.external_id ?? "")
        if (!oExt) continue
        outcomeRows.push({
          source: SOURCE,
          external_id: oExt,
          label: String(o?.label ?? ""),
          price: Number(o?.price),
          handicap: (o?.handicap ?? null) as number | null,
          __market_ext: mExt
        })
      }
    }
  }

  const marketRowsDeduped = uniqBy(marketRows, m => [m.source, m.external_id])
  await upsertMarkets(db, marketRowsDeduped)
  const marketIdMap = await getMarketsIdMap(db, SOURCE, marketRowsDeduped.map(m => m.external_id))

  const withMarket = outcomeRows
    .map(o => ({ ...o, market_id: o.__market_ext && marketIdMap[o.__market_ext] ? marketIdMap[o.__market_ext] : undefined }))
    .filter(o => typeof o.market_id === "number")
    .map(({ __market_ext, ...rest }) => rest as Outcome)

  const outcomesDeduped = uniqBy(withMarket, o => [o.market_id, o.label, o.handicap])
  await upsertOutcomes(db, outcomesDeduped)
}

async function persistMarketsForMatch(env: WorkerEnv, matchId: string, markets: any[]) {
  const db = getClient(env)
  const g = await db
    .from("games")
    .select("id")
    .eq("source", SOURCE)
    .eq("external_id", matchId)
    .maybeSingle()
  if (!g.data?.id) throw new Error(`game not found for matchId=${matchId}`)
  const gameId = g.data.id as number

  const marketRows: Market[] = []
  const outcomeRows: Outcome[] = []
  for (const m of markets) {
    if (!m?.external_id) continue
    marketRows.push({
      source: SOURCE,
      external_id: String(m.external_id),
      key: String(m.key ?? "other"),
      name: String(m.name ?? "Market"),
      game_id: gameId
    })
    const outs = Array.isArray(m?.outcomes) ? m.outcomes : []
    for (const o of outs) {
      if (!o?.external_id) continue
      outcomeRows.push({
        source: SOURCE,
        external_id: String(o.external_id),
        label: String(o.label ?? ""),
        price: Number(o.price),
        handicap: (o.handicap ?? null) as number | null
      })
    }
  }

  const marketRowsDeduped = uniqBy(marketRows, m => [m.source, m.external_id])

  await upsertMarkets(db, marketRowsDeduped)
  const marketIdMap = await getMarketsIdMap(db, SOURCE, marketRowsDeduped.map(m => m.external_id))

  const marketExtSet = new Set(marketRowsDeduped.map(m => m.external_id))

  const outToMarketExt = new Map<string, string>()
  for (const m of markets) {
    const mExt = String(m?.external_id ?? "")
    if (!mExt || !marketExtSet.has(mExt)) continue
    const outs = Array.isArray(m?.outcomes) ? m.outcomes : []
    for (const o of outs) {
      const oExt = String(o?.external_id ?? "")
      if (oExt && !outToMarketExt.has(oExt)) outToMarketExt.set(oExt, mExt)
    }
  }

  for (const o of outcomeRows) {
    const mExt = outToMarketExt.get(o.external_id)
    if (mExt && marketIdMap[mExt]) o.market_id = marketIdMap[mExt]
  }

  const withMarket = outcomeRows.filter(o => typeof o.market_id === "number")
  const deduped = uniqBy(withMarket, o => [o.market_id, o.label, o.handicap])
  await upsertOutcomes(db, deduped)
}

async function fetchMatchMarkets(matchId: string) {
  const headers = {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    "x-requested-with": "XMLHttpRequest"
  }
  const qs = `matchId=${encodeURIComponent(matchId)}`
  const urls = [`https://tounesbet.com/Match/MatchOddsGrouped?${qs}`, `http://tounesbet.com/Match/MatchOddsGrouped?${qs}`]

  let last: { status: number; finalUrl: string; text: string; contentType: string | null } | null = null
  for (const u of urls) {
    const fetched = await getTextWithDdosBypassDetailed(u, headers)
    last = fetched
    if (fetched.status >= 200 && fetched.status < 300) {
      return parseMatchOddsGrouped(fetched.text, matchId)
    }
  }
  throw new Error(`MatchOddsGrouped failed status=${last?.status} url=${last?.finalUrl}`)
}

export async function runPrematchDiscovery(env: WorkerEnv, opts?: { batch?: number }) {
  const db = getClient(env)
  const sportId = env.DEFAULT_SPORT_ID || "1181"
  const betRangeFilter = "0"
  const lockOwner = `worker:${Math.random().toString(16).slice(2)}`

  const futureCutoffIso = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
  try {
    const unstick = await db
      .from("scrape_queue")
      .update({ not_before_at: null })
      .eq("source", SOURCE)
      .eq("task", "prematch_catalog_page")
      .eq("status", "pending")
      .is("last_success_at", null)
      .gt("not_before_at", futureCutoffIso)
    if (unstick.error) throw new Error(`prematch_catalog_page unstick failed: ${JSON.stringify(unstick.error)}`)
  } catch {
  }

  const EMPTY_STREAK_LIMIT = 8

  const batch = Math.max(1, Math.min(5, Number(opts?.batch ?? 3) || 3))
  let tasks = await claimScrapeTasks(db, SOURCE, "prematch_catalog_page", batch, lockOwner)
  if (!tasks.length) {
    const nowIso = new Date().toISOString()
    const existing = await db
      .from("scrape_queue")
      .select("id")
      .eq("source", SOURCE)
      .eq("task", "prematch_catalog_page")
      .limit(1)
    if (existing.error) throw new Error(`prematch_catalog_page existence check failed: ${JSON.stringify(existing.error)}`)
    if ((existing.data ?? []).length === 0) {
      await upsertScrapeQueue(db, [{
        source: SOURCE,
        task: "prematch_catalog_page",
        external_id: `${sportId}:${betRangeFilter}:1:0`,
        status: "pending",
        priority: 50
      }])
      tasks = await claimScrapeTasks(db, SOURCE, "prematch_catalog_page", batch, lockOwner)
    } else {
      const soonest = await db
        .from("scrape_queue")
        .select("not_before_at")
        .eq("source", SOURCE)
        .eq("task", "prematch_catalog_page")
        .eq("status", "pending")
        .not("not_before_at", "is", null)
        .order("not_before_at", { ascending: true })
        .limit(1)
      if (soonest.error) throw new Error(`prematch_catalog_page min not_before_at check failed: ${JSON.stringify(soonest.error)}`)
      const nb = (soonest.data ?? [])?.[0]?.not_before_at ? String((soonest.data ?? [])?.[0]?.not_before_at) : null
      const nbMs = nb ? Date.parse(nb) : NaN
      const thresholdMs = 2 * 60 * 60 * 1000
      if (Number.isFinite(nbMs) && nbMs - Date.now() > thresholdMs) {
        const upd = await db
          .from("scrape_queue")
          .update({ not_before_at: null, locked_at: null, lock_owner: null, status: "pending" })
          .eq("source", SOURCE)
          .eq("task", "prematch_catalog_page")
          .eq("status", "pending")
          .gt("not_before_at", nowIso)
        if (upd.error) throw new Error(`prematch_catalog_page auto-expedite failed: ${JSON.stringify(upd.error)}`)
        tasks = await claimScrapeTasks(db, SOURCE, "prematch_catalog_page", batch, lockOwner)
      }
    }
  }

  const results: { pages: number; games: number; enqueued1x2: number; nextPagesEnqueued: number; fail: number; processed: { id: number; external_id: string; page: number }[] } = {
    pages: 0,
    games: 0,
    enqueued1x2: 0,
    nextPagesEnqueued: 0,
    fail: 0,
    processed: []
  }
  const oneHourLater = () => new Date(Date.now() + 60 * 60 * 1000).toISOString()
  const sixHoursLater = () => new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString()
  const backoffLater = (attempts: number) => new Date(Date.now() + Math.min(60, 5 * Math.max(1, attempts)) * 60 * 1000).toISOString()

  const enqueue1x2Ids: string[] = []
  const enqueueNextPages: string[] = []
  const successIds: number[] = []
  const emptySuccessIds: number[] = []
  const failures: { id: number; attempts: number; error: string }[] = []

  for (const t of tasks) {
    const id = Number(t.id)
    const attempts = Number(t.attempts ?? 0)
    const ext = String(t.external_id ?? "")
    const parts = ext.split(":")
    const page = Number(parts[2] ?? "1")
    const sId = parts[0] || sportId
    const br = parts[1] || betRangeFilter
    const emptyStreak = Number(parts[3] ?? "0")

    try {
      const html = await getSportMatchListHTML(sId, br, page)
      const parsed = parsePrematchSportMatchList(html, sId)
      const res = await persistParsed(env, parsed)

      const games = parsed.flatMap(s => s.leagues).flatMap(l => l.games)
      results.pages++
      results.games += res.games
      results.processed.push({ id, external_id: ext, page })

      const nextEmptyStreak = games.length ? 0 : (emptyStreak + 1)

      if (games.length) {
        for (const g of games) enqueue1x2Ids.push(String(g.external_id))
      }

      if (!games.length && nextEmptyStreak >= EMPTY_STREAK_LIMIT) {
      } else {
        const fanout = games.length ? 3 : 1
        for (let k = 1; k <= fanout; k++) {
          const np = page + k
          if (np > 250) break
          enqueueNextPages.push(`${sId}:${br}:${np}:${nextEmptyStreak}`)
        }
      }

      successIds.push(id)
      if (!games.length) emptySuccessIds.push(id)
    } catch (e) {
      results.fail++
      failures.push({ id, attempts, error: String(e) })
    }
  }

  if (enqueue1x2Ids.length) {
    const uniq = Array.from(new Set(enqueue1x2Ids))
    await upsertScrapeQueue(db, uniq.map(external_id => ({
      source: SOURCE,
      task: "prematch_1x2",
      external_id,
      status: "pending",
      priority: 10
    })))
    results.enqueued1x2 += uniq.length
  }

  if (enqueueNextPages.length) {
    const uniq = Array.from(new Set(enqueueNextPages))
    await upsertScrapeQueue(db, uniq.map(external_id => ({
      source: SOURCE,
      task: "prematch_catalog_page",
      external_id,
      status: "pending",
      priority: 20
    })))
    results.nextPagesEnqueued += uniq.length
  }

  if (successIds.length) {
    const next = oneHourLater()
    const nextEmpty = sixHoursLater()
    const now = new Date().toISOString()

    const normalIds = successIds.filter(x => !emptySuccessIds.includes(x))

    if (normalIds.length) {
      const upd = await db
        .from("scrape_queue")
        .update({
          status: "pending",
          not_before_at: next,
          locked_at: null,
          lock_owner: null,
          last_error: null,
          last_success_at: now
        })
        .in("id", normalIds)
      if (upd.error) throw new Error(`updateScrapeTask batch failed: ${JSON.stringify(upd.error)}`)
    }

    if (emptySuccessIds.length) {
      const updEmpty = await db
        .from("scrape_queue")
        .update({
          status: "pending",
          not_before_at: nextEmpty,
          locked_at: null,
          lock_owner: null,
          last_error: null,
          last_success_at: now
        })
        .in("id", emptySuccessIds)
      if (updEmpty.error) throw new Error(`updateScrapeTask empty batch failed: ${JSON.stringify(updEmpty.error)}`)
    }
  }

  for (const f of failures) {
    try {
      await updateScrapeTask(db, f.id, {
        status: "pending",
        not_before_at: backoffLater(f.attempts),
        locked_at: null,
        lock_owner: null,
        last_error: f.error
      })
    } catch {
    }
  }

  return results
}

export async function runPrematchHourly(env: WorkerEnv, batch = 12) {
  const db = getClient(env)
  const lockOwner = `worker:${Math.random().toString(16).slice(2)}`
  const safeBatch = Math.max(1, Math.min(15, Number(batch) || 12))
  const tasks = await claimScrapeTasks(db, SOURCE, "prematch_1x2", safeBatch, lockOwner)
  const results: { ok: number; fail: number } = { ok: 0, fail: 0 }
  const oneHourLater = () => new Date(Date.now() + 60 * 60 * 1000).toISOString()
  const backoffLater = (attempts: number) => new Date(Date.now() + Math.min(60, 5 * Math.max(1, attempts)) * 60 * 1000).toISOString()

  const matchIdToMarkets = new Map<string, any[]>()
  const successIds: number[] = []
  const failures: { id: number; attempts: number; error: string }[] = []

  for (const t of tasks) {
    const id = Number(t.id)
    const matchId = String(t.external_id)
    const attempts = Number(t.attempts ?? 0)
    try {
      const markets = await fetchMatchMarkets(matchId)
      const oneX2 = pick1x2Only(markets)
      matchIdToMarkets.set(matchId, oneX2)
      successIds.push(id)
    } catch (e) {
      failures.push({ id, attempts, error: String(e) })
    }
  }

  if (matchIdToMarkets.size) {
    await persistMarketsForMatches(env, matchIdToMarkets)
  }

  if (successIds.length) {
    const next = oneHourLater()
    const now = new Date().toISOString()
    const upd = await db
      .from("scrape_queue")
      .update({
        status: "pending",
        not_before_at: next,
        locked_at: null,
        lock_owner: null,
        last_error: null,
        last_success_at: now
      })
      .in("id", successIds)
    if (upd.error) throw new Error(`updateScrapeTask batch failed: ${JSON.stringify(upd.error)}`)
    results.ok += successIds.length
  }

  for (const f of failures) {
    try {
      await updateScrapeTask(db, f.id, {
        status: "pending",
        not_before_at: backoffLater(f.attempts),
        locked_at: null,
        lock_owner: null,
        last_error: f.error
      })
    } catch {
    }
    results.fail++
  }

  return results
}

export async function servePrematchFullMarkets(env: WorkerEnv, matchId: string, forceFresh: boolean) {
  const db = getClient(env)
  const ttlMs = 60 * 60 * 1000
  const g = await db
    .from("games")
    .select("id")
    .eq("source", SOURCE)
    .eq("external_id", matchId)
    .maybeSingle()
  if (!g.data?.id) throw new Error("not_found:game")

  const row = await db
    .from("scrape_queue")
    .select("id,last_success_at")
    .eq("source", SOURCE)
    .eq("task", "prematch_full_markets")
    .eq("external_id", matchId)
    .maybeSingle()

  const last = row.data?.last_success_at ? Date.parse(String(row.data.last_success_at)) : 0
  const fresh = last > 0 && Date.now() - last < ttlMs
  if (!forceFresh && fresh) {
    const marketsRes = await db.from("markets").select("id,game_id,key,name").eq("game_id", g.data.id)
    const marketsData = (marketsRes.data ?? []) as { id: number; game_id: number; key: string; name: string }[]
    const marketIds = marketsData.map(m => m.id)
    const outsRes = marketIds.length ? await db.from("outcomes").select("id,market_id,label,price,handicap").in("market_id", marketIds) : { data: [] as any[] }
    const outs = (outsRes.data ?? []) as { id: number; market_id: number; label: string; price: number; handicap: number | null }[]
    const byMarket = new Map<number, any[]>()
    for (const m of marketsData) byMarket.set(m.id, [])
    for (const o of outs) (byMarket.get(o.market_id) ?? []).push({ id: o.id, label: o.label, price: o.price, handicap: o.handicap })
    return {
      matchId,
      cached: true,
      last_success_at: row.data?.last_success_at ?? null,
      markets: marketsData.map(m => ({ id: m.id, key: m.key, name: m.name, outcomes: byMarket.get(m.id) ?? [] }))
    }
  }

  await upsertScrapeQueue(db, [{
    source: SOURCE,
    task: "prematch_full_markets",
    external_id: matchId,
    status: "pending",
    priority: 5
  }])

  const markets = await fetchMatchMarkets(matchId)
  await persistMarketsForMatch(env, matchId, markets)
  const next = new Date(Date.now() + ttlMs).toISOString()
  if (row.data?.id) {
    await updateScrapeTask(db, Number(row.data.id), {
      status: "pending",
      not_before_at: next,
      locked_at: null,
      lock_owner: null,
      last_error: null,
      last_success_at: new Date().toISOString()
    })
  } else {
    const claimed = await db
      .from("scrape_queue")
      .select("id")
      .eq("source", SOURCE)
      .eq("task", "prematch_full_markets")
      .eq("external_id", matchId)
      .maybeSingle()
    if (claimed.data?.id) {
      await updateScrapeTask(db, Number(claimed.data.id), {
        status: "pending",
        not_before_at: next,
        locked_at: null,
        lock_owner: null,
        last_error: null,
        last_success_at: new Date().toISOString()
      })
    }
  }

  return { matchId, cached: false, markets }
}

export async function runPrematch(env: WorkerEnv) {
  const sportId = env.DEFAULT_SPORT_ID || "1181"
  let navHtml: string
  try {
    navHtml = await getSportHTML(sportId)
  } catch {
    navHtml = await getNextMatchesHTML(sportId)
  }
  const selected = getSelectedSportIdFromNav(navHtml) || sportId

  const nextHtml = await getNextMatchesHTML(selected)
  const parsed = parsePrematchNextMatches(nextHtml, selected)

  const games = parsed.flatMap(s => s.leagues).flatMap(l => l.games)
  const maxDeepGames = Math.min(12, games.length)
  for (let i = 0; i < maxDeepGames; i++) {
    const g = games[i]
    try {
      const fetched = await getTextWithDdosBypassDetailed(`https://tounesbet.com/Match/MatchOddsGrouped?matchId=${encodeURIComponent(g.external_id)}`, {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        "x-requested-with": "XMLHttpRequest"
      })
      if (fetched.status >= 200 && fetched.status < 300) {
        g.markets = capMarkets(parseMatchOddsGrouped(fetched.text, g.external_id))
      }
    } catch {
    }
  }
  try {
    const popHtml = await getPopularMatchesHTML(selected, "all_days", "0")
    const league = parsePopularMatchesFragment(popHtml, selected)
    if (league) {
      const target = parsed.find(s => s.external_id === selected)
      if (target) target.leagues.push(league)
    }
  } catch (e) {
    console.error("PopularMatches fetch/parse failed", String(e))
  }

  const res = await persistParsed(env, parsed)
  return res
}

export async function runLive(env: WorkerEnv) {
  const html = await getLiveHTML()
  const parsed = parseLive(html)
  const res = await persistParsed(env, parsed)
  return res
}
