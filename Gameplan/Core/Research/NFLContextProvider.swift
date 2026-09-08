import Foundation

/// One NFL game in a given week.
///
/// This is the missing link that everything else hangs off. Until the app knows
/// who each team plays and when, it cannot work out a player's opponent, cannot
/// look up weather at the right stadium at the right time, and cannot read the
/// betting market for the game. A fantasy platform's league feed does not carry
/// this — it is a fact about the NFL, not about your league.
struct NFLGame: Codable, Hashable, Sendable {
    var id: String
    var homeTeamAbbreviation: String
    var awayTeamAbbreviation: String
    var kickoff: Date?
    /// True for domes and closed roofs. Weather is not a factor for these.
    var isIndoor: Bool
    /// Market view of the game, when the source supplies one. Spread is stated
    /// from the home team's perspective, negative meaning the home team is
    /// favoured, which is the usual convention.
    var overUnder: Double?
    var homeSpread: Double?

    init(
        id: String,
        homeTeamAbbreviation: String,
        awayTeamAbbreviation: String,
        kickoff: Date? = nil,
        isIndoor: Bool = false,
        overUnder: Double? = nil,
        homeSpread: Double? = nil
    ) {
        self.id = id
        self.homeTeamAbbreviation = homeTeamAbbreviation
        self.awayTeamAbbreviation = awayTeamAbbreviation
        self.kickoff = kickoff
        self.isIndoor = isIndoor
        self.overUnder = overUnder
        self.homeSpread = homeSpread
    }

    func opponent(of team: String) -> String? {
        if team == homeTeamAbbreviation { return awayTeamAbbreviation }
        if team == awayTeamAbbreviation { return homeTeamAbbreviation }
        return nil
    }

    func isHome(_ team: String) -> Bool { team == homeTeamAbbreviation }

    func involves(_ team: String) -> Bool {
        team == homeTeamAbbreviation || team == awayTeamAbbreviation
    }

    /// Betting context from the perspective of one of the two teams.
    func bettingContext(for team: String) -> BettingContext {
        guard let homeSpread else { return BettingContext(overUnder: overUnder, spread: nil) }
        return BettingContext(
            overUnder: overUnder,
            spread: isHome(team) ? homeSpread : -homeSpread
        )
    }

    /// Converted for the weather provider, which keys off the home stadium.
    func scheduled(week: Int) -> ScheduledGame {
        ScheduledGame(
            homeTeamAbbreviation: homeTeamAbbreviation,
            awayTeamAbbreviation: awayTeamAbbreviation,
            kickoff: kickoff,
            week: week
        )
    }
}

/// Facts about the NFL itself, as opposed to facts about your fantasy league.
///
/// Kept separate from `FantasyDataProvider` on purpose: the schedule, the
/// injury report and the depth chart are the same for everyone, whatever
/// platform their league lives on. A Sleeper user and an ESPN user share this
/// half of the data, so it should not be tangled up with either one's league
/// feed.
///
/// Every method is best-effort and non-throwing. Missing NFL context degrades
/// the explanation; it must never fail the week's analysis.
protocol NFLContextProvider: Sendable {
    var identifier: String { get }

    /// Every game in the given week.
    func games(season: Int, week: Int) async -> [NFLGame]

    /// Depth chart position by the provider's own player identifier, where 1 is
    /// the starter. Empty when unavailable.
    func depthChart(season: Int) async -> [String: Int]

    /// Current injury reports by the provider's own player identifier.
    func injuryReports(season: Int) async -> [String: InjuryReport]
}

extension NFLContextProvider {
    func depthChart(season: Int) async -> [String: Int] { [:] }
    func injuryReports(season: Int) async -> [String: InjuryReport] { [:] }
}

/// Supplies nothing. Used by the demo league, which carries its own schedule,
/// and as the fallback when a user has turned network research off.
struct EmptyNFLContextProvider: NFLContextProvider {
    let identifier = "none"
    func games(season: Int, week: Int) async -> [NFLGame] { [] }
}
