export interface Sport {
  id?: number
  source: string
  external_id: string
  key: string
  name: string
}

export interface League {
  id?: number
  source: string
  external_id: string
  sport_id?: number
  name: string
}

export interface Game {
  id?: number
  source: string
  external_id: string
  league_id?: number
  home_team: string
  away_team: string
  start_time: string
  last_seen_at?: string
  live: boolean
}

export interface Market {
  id?: number
  source: string
  external_id: string
  game_id?: number
  key: string
  name: string
}

export interface Outcome {
  id?: number
  source: string
  external_id: string
  market_id?: number
  label: string
  price: number
  handicap: number | null
}

export interface ParsedSport {
  key: string
  name: string
  external_id: string
  leagues: ParsedLeague[]
}

export interface ParsedLeague {
  name: string
  external_id: string
  games: ParsedGame[]
}

export interface ParsedGame {
  external_id: string
  home_team: string
  away_team: string
  start_time: string
  live: boolean
  markets: ParsedMarket[]
}

export interface ParsedMarket {
  key: string
  name: string
  external_id: string
  outcomes: ParsedOutcome[]
}

export interface ParsedOutcome {
  label: string
  price: number
  handicap: number | null
  external_id: string
}

export interface LiveMeta {
  provider: string
  provider_ls_id: string | null
  provider_event_id: string | null
  status_name: string | null
  clock_time: number | null
  start_time: string | null
  home_team: string | null
  away_team: string | null
  home_score: number | null
  away_score: number | null
  competition_name: string | null
}
