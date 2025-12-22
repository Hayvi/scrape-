import { Game, League, Market, Outcome, ParsedSport, Sport } from "../domain"
import { getClient, getGamesIdMap, getLeaguesIdMap, getMarketsIdMap, getSportsIdMap, upsertGames, upsertLeagues, upsertMarkets, upsertOutcomes, upsertSports } from "../db"

type WorkerEnv = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string; DEFAULT_SPORT_ID?: string }

const SOURCE = "tounesbet"

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

export async function persistMarketsForMatches(env: WorkerEnv, matchIdToMarkets: Map<string, any[]>) {
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

export async function persistMarketsForMatch(env: WorkerEnv, matchId: string, markets: any[]) {
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
