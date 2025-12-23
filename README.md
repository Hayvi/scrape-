# odds-scraper-worker

Cloudflare Worker that scrapes sports betting data from **tounesbet.com**, persists it into **Supabase**, and serves it via JSON APIs.

- Worker name: `odds-scraper-worker`
- Entry: `src/index.ts`
- Deploy config: `wrangler.toml`

## Requirements

- Node.js (for local dev / deploy)
- Cloudflare Wrangler
- Supabase project (Postgres)

## Environment variables

The Worker expects these bindings:

- `SUPABASE_URL` (required)
- `SUPABASE_SERVICE_ROLE_KEY` (required)
- `DEFAULT_SPORT_ID` (optional, default `1181`)

> Note: do **not** expose the service role key in client apps. It must only live in the Worker environment.

## Cron schedules

Configured in `wrangler.toml`:

- `*/1 * * * *` (every minute): runs `runLive(env)` and `runPrematchDiscovery(env)`
- `0 * * * *` (every hour): runs `runPrematchHourly(env)`
- `5 */6 * * *` (every 6 hours): runs `runPrematchDiscovery(env)`

## Database schema

Create the required tables in Supabase by running:

- `sql/schema.sql`

Tables used:

- `sports`
- `leagues`
- `games`
- `markets`
- `outcomes`
- `live_meta`

## Market parsing note

- The upstream `MatchOddsGrouped` payload contains many distinct markets that may share similar names.
- Markets are stored with a unique `external_id` per match+market row to avoid upsert collisions.

## HTTP API

Base URL (example): `https://<your-worker>.workers.dev`

### 1X2 odds reliability

- Canonical 1X2 market external_id: `${matchId}_1x2` (persisted during prematch discovery from the matchlist HTML).
- `/api/odds/prematch/<sport>` fetches only this canonical market per game and returns exactly 3 outcomes labeled `1`, `X`, `2`.
- Outcomes are fetched via nested select in the same query to avoid truncation or bigint/string ID mismatches.
- Include stale/seen filters: `?includeStale=1&seenWithinMinutes=720` are useful when checking coverage.
- Quick check for a specific match: `/api/odds/prematch/football?includeStale=1&seenWithinMinutes=720` and find `externalId` = matchId; the first market should have 3 outcomes.

## Frontend tester (Cloudflare Pages)

This repo also includes a tiny Cloudflare Pages site to test the Worker endpoints from the browser.

- Static UI: `pages/index.html`
- Static assets:
  - `pages/styles.css`
  - `pages/app/index.js` (ES module entrypoint)
  - `pages/app/*.js` (small UI modules)
- Proxy function: `functions/api/[[path]].ts`

The UI calls `/api/...` on the Pages domain, and the Pages Function proxies those requests to your Worker.

### Pages environment variables

Set this in your Cloudflare Pages project:

- `API_BASE_URL` (required)
  - Example: `https://odds-scraper-worker.ghzwael.workers.dev`

### Deploy Pages

In Cloudflare Dashboard:

- **Build command**: *(empty)*
- **Build output directory**: `pages`
- **Functions directory**: `functions`

After deploy, open the Pages site root (`/`) and use the buttons / custom path box.

### UI notes

- Markets are grouped into categories (Populaire / BUTS / HANDICAP / ...) and show both counts:
  - `X markets / Y outcomes`
- Sidebar includes:
  - `Only show games with 1X2 odds`
  - `Hide competitions with 0 games`

### Health / config

#### `GET /api/test/env`
Returns a JSON report about whether env vars are present/valid.

---

## Scrape / test endpoints

These endpoints **fetch + parse** the upstream site. They can optionally **persist** results into Supabase.

### `GET /api/test/live`
Scrape live matches.

Query params:

- `persist=1` (optional) persist parsed data to Supabase
- `debug=1` (optional) includes extra debug info about fetched HTML and parsing signals
- `deep=1` (optional) additionally fetches per-match odds from `MatchOddsGrouped` (more expensive)
- `discover=1` (optional, only meaningful with `debug=1`) tries to extract websocket/http candidates from site JS
- `limit=<1..25>` (optional, default `10`) limits fallback match IDs

Notes:

- If the main live table parsing fails, the endpoint may fall back to extracting IDs from widgets or `/Match/TopMatches`.

### `GET /api/test/prematch`
Scrape prematch (upcoming) matches.

Query params:

- `persist=1` (optional) persist parsed data to Supabase
- `deep=1` (optional) fetch odds for up to `min(limit, 3)` games
- `limit=<1..25>` (optional, default `10`) affects deep fetch limit

### `GET /api/test/match/:matchId`
Fetch and parse odds markets/outcomes for a specific match.

Query params:

- `debug=1` (optional) includes parsing signals/snippets

Example:

- `/api/test/match/11834326`

### `GET /api/test/probe?path=...`
Fetches a raw path (relative to `https://tounesbet.com`) and returns basic parsing signals + extracted match IDs.

Query params:

- `path` (required) e.g. `/Match/TopMatches`

### `GET /api/test/statscore/:lsId`
Fetch and parse live metadata from Statscore SSR.

Query params:

- `wg` (optional) widget group id (default is hardcoded in code)
- `tz` (optional) timezone offset (default `0`)
- `persist=1` (optional) upserts parsed data into `live_meta`

---

### `GET /api/test/stats`
Returns high-level counters computed from Supabase.

Query params:

- `sportKey` (optional, default `football`)
- `seenWithinMinutes` (optional, default `180`) filters prematch games by `games.last_seen_at`
- `includeStale=1` (optional) disables the `last_seen_at` filter

### `GET /api/test/run/prematch_discovery`
Runs the prematch discovery crawl (queue-driven pagination).

Query params:

- `batch=<1..5>` (optional) number of catalog pages to process in this run

### `GET /api/test/queue`
Inspect or manipulate `scrape_queue`.

Query params:

- `action=peek` (optional) lists queue rows for a given task
- `action=expedite` (optional) clears `not_before_at` + locks for a specific task row

### `GET /api/test/matchlist_fetch_debug`
Fetches raw match list HTML using both the "new" and "legacy" upstream URL patterns and returns response metadata + signals.

Query params:

- `sportId` (optional)
- `betRangeFilter` (optional)
- `page` (optional)
- `dateDay` (optional) forwarded as `DateDay=...` to upstream for debugging

### `GET /api/test/matchlist_parse_debug`
Fetches + parses a match list page and returns parsing coverage signals.

## Read endpoints (from Supabase)

These endpoints read from your Supabase tables and return a hierarchical response:

`sport -> leagues -> games -> markets -> outcomes`

### `GET /api/odds/prematch/:sportKey`
Returns **non-live** games (`live=false`) for the sport key.

By default this endpoint only returns games that are:

- `start_time > now()` (upcoming)
- seen recently (`games.last_seen_at` within `seenWithinMinutes`)

Query params:

- `seenWithinMinutes` (optional, default `180`)
- `includeStale=1` (optional) disables the `last_seen_at` filter

Example:

- `/api/odds/prematch/football`

### `GET /api/odds/live/:sportKey`
Returns **live** games (`live=true`) for the sport key.

Example:

- `/api/odds/live/football`

---

## Local development

```bash
npm install
npx wrangler dev
```

## Deploy

```bash
npm install
npx wrangler deploy
```

## Local development (Pages UI)

To run the tester UI locally (including the `/api/*` proxy), bind `API_BASE_URL` to your worker:

```bash
npx wrangler pages dev ./pages -b API_BASE_URL=https://odds-scraper-worker.ghzwael.workers.dev
```

If your system Node.js is old, you can deploy with a temporary Node 20 + wrangler:

```bash
npx -y -p node@20 -p wrangler@3.95.0 -c "wrangler deploy"
```

## Prematch discovery notes

- Prematch discovery uses the upstream `/Sport/{sportId}` pagination pattern.
- Requests include `DateDay=all_days` so deeper pages continue returning matches.
- When a catalog page is empty, it is re-scheduled further in the future to avoid starving refresh of populated pages.
