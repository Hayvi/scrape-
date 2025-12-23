export function createState() {
  return {
    mode: "prematch",
    data: null,
    selectedLeagueId: null,
    leagueSearch: "",
    debugOpen: false,
    onlyWithOdds: false,
    hideEmptyCompetitions: false,
    oddsIncludeStale: false,
    oddsIncludeStarted: false,
    oddsSeenMins: 180,
    expanded: {},
    expandedLoading: {},
    expandedError: {},
    expandedMarkets: {},
    expandedCats: {},
    expandedCountries: {},
  }
}
