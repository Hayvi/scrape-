# Using results to compare players’ betting

Your app already scrapes **fixtures + odds**. To compare players’ betting performance, you need to add **results ingestion** and **bet settlement**.

## 1) What you need (high level)
To “compare players betting”, you need:

- **Results** (final score + match status) for each `games.external_id`.
- A way to **store players’ bets** (who bet what, at what odds/time).
- A **settlement step**: result → win/lose/void per selection (and per bet slip).
- **Comparison metrics** (ROI, hit rate, yield, CLV, etc.) + leaderboards.

## 2) Getting results (where to fetch them)
You have 2 realistic options:

### Option A: Use the same provider you already use for live metadata (recommended)
You already ingest and store `live_meta` from **Statscore SSR**.

- If Statscore provides `FT` (full-time) status + final score, you can ingest that.
- This is usually easiest because you already have the plumbing and identifiers.

### Option B: Use a separate results API/provider
Examples: API-Football, Sportmonks, Soccerdata feeds, etc.

- You must map their event IDs to your `games.external_id` (tounesbet matchId).
- **Mapping is the hardest part**. Without a stable mapping, results ingestion will be unreliable.

**Key point:** results ingestion only works if you can reliably map the result event → your `games.external_id`.

## 3) Store results in your DB
Simplest schema approaches:

### Option A: Extend the `games` table
Add columns like:

- `status` (`scheduled|live|ft|cancelled|postponed`)
- `home_score`, `away_score`
- `ended_at` / `result_seen_at`

### Option B: Create a `game_results` table
Useful if you want:

- Multiple sources
- Audit history
- Result revisions

Example fields:

- `source`
- `game_id`
- `status`
- `home_score`, `away_score`
- timestamps

## 4) Model “players betting”
You won’t be able to see *other people’s* private bets on tounesbet.

So “compare other players” typically means: **players in your app** (users) whose bets you store.

Typical tables:

- `players` — your users
- `bets` — one bet slip (`player_id`, `placed_at`, `stake`, `type`)
- `bet_selections` — each pick (`bet_id`, `game_external_id`, market key like `1x2`, selection `1|X|2`, `odds_taken`, `taken_at`)

## 5) Settlement logic (turn results → bet outcomes)
After a game reaches `FT`:

### Settlement for 1X2 (example)
For each selection (market `1x2`):

- Home win if `home_score > away_score`
- Draw if `home_score == away_score`
- Away win if `home_score < away_score`

Mark each selection as:

- `win`
- `lose`
- `void` (postponed/cancelled/abandoned rules)

### Settle the bet slip
- **Singles**: payout = `stake * odds` if win else `0` (void rules apply)
- **Accumulators**: multiply odds of winning legs; any losing leg loses the slip; void legs treated like odds = `1`

## 6) Comparison metrics you can compute
Once bets are settled, you can compare players using:

- **Hit rate** = wins / settled picks
- **ROI / Yield** = `profit / stake`
- **Profit** = `total_return − total_stake`
- **Average odds taken**

### CLV (Closing Line Value) (advanced)
- Requires storing “closing odds” at kickoff (or at match start)
- Compare closing odds vs `odds_taken`

## 7) Questions to decide before implementation
- What do you consider a “result”?
  - Only football FT scores?
  - Handling postponed/cancelled/abandoned?
- Do players place bets **inside your app**, or do you want to import bets from somewhere else?
- Which results source do you want?
  - Statscore (since you already use it) vs an external results API.
