import Foundation

/// A team in a league, as shown in the "which one is yours?" step of onboarding.
struct TeamSummary: Identifiable, Hashable, Sendable {
    var id: String
    var name: String
    var ownerName: String?
    var recordLabel: String
}

/// A league the user can choose during onboarding.
struct LeagueSummary: Identifiable, Hashable, Sendable {
    var id: String
    var name: String
    var season: Int
    var teamCount: Int
    var userTeamID: String?
    var userTeamName: String?
}

/// The one seam between this app and whatever service supplies fantasy data.
///
/// Everything above this protocol — models, engine, UI — is platform agnostic.
/// Swapping ESPN for Sleeper, Yahoo, or a backend of your own means writing one
/// new conformance and nothing else.
protocol FantasyDataProvider: Sendable {
    /// Identifies the provider in logs and in namespaced player IDs.
    var identifier: String { get }
    /// True when the provider is returning clearly-labelled sample data rather
    /// than a real league.
    var isDemo: Bool { get }

    /// Leagues visible to the current credentials.
    func availableLeagues() async throws -> [LeagueSummary]

    /// Full league configuration: scoring, roster slots, waiver rules.
    func league(id: String, season: Int) async throws -> League

    /// The week the league considers current.
    func currentWeek(leagueID: String, season: Int) async throws -> Int

    /// Every team in the league, so the user can identify their own.
    func teams(leagueID: String, season: Int) async throws -> [TeamSummary]

    /// The user's matchup for a week, with both rosters fully populated.
    func matchup(leagueID: String, season: Int, week: Int, teamID: String) async throws -> Matchup

    /// Unrostered players worth considering, already trimmed to a useful size.
    func freeAgents(leagueID: String, season: Int, week: Int, limit: Int) async throws -> [PlayerContext]

    /// Recent league activity. Optional — a provider that cannot supply this
    /// should return an empty array rather than throwing.
    func recentTransactions(leagueID: String, season: Int) async throws -> [Transaction]
}

extension FantasyDataProvider {
    func recentTransactions(leagueID: String, season: Int) async throws -> [Transaction] { [] }
}

/// Errors any provider can raise. The UI maps these to specific, actionable
/// empty and error states rather than a generic failure message.
enum FantasyDataError: LocalizedError, Equatable {
    case notConfigured
    case authenticationRequired
    case authenticationFailed
    case leagueNotFound(String)
    case teamNotFound(String)
    case weekNotAvailable(Int)
    case rateLimited
    case network(String)
    case decoding(String)
    case unsupported(String)

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "No league is connected yet."
        case .authenticationRequired:
            return "This league is private and needs your ESPN session details."
        case .authenticationFailed:
            return "ESPN rejected those session details."
        case .leagueNotFound(let id):
            return "Couldn't find league \(id)."
        case .teamNotFound(let id):
            return "Couldn't find team \(id) in this league."
        case .weekNotAvailable(let week):
            return "Week \(week) isn't available yet."
        case .rateLimited:
            return "The data source is rate limiting requests. Try again shortly."
        case .network(let detail):
            return "Network problem: \(detail)"
        case .decoding:
            return "The data source returned something unexpected."
        case .unsupported(let detail):
            return detail
        }
    }

    /// What the user can actually do about it.
    var recoverySuggestion: String? {
        switch self {
        case .notConfigured:
            return "Connect a league in Settings, or explore the demo league."
        case .authenticationRequired, .authenticationFailed:
            return "Re-enter your espn_s2 and SWID values in Settings → ESPN Connection."
        case .leagueNotFound:
            return "Double-check the league ID from your ESPN league URL."
        case .teamNotFound:
            return "Pick your team again in Settings."
        case .weekNotAvailable:
            return "Check back once the week opens."
        case .rateLimited:
            return "Wait a minute and pull to refresh."
        case .network:
            return "Check your connection and pull to refresh."
        case .decoding:
            return "This can happen when the provider changes its format. Try the demo league while it's investigated."
        case .unsupported:
            return nil
        }
    }

    var requiresCredentials: Bool {
        self == .authenticationRequired || self == .authenticationFailed
    }
}
