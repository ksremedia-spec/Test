import Foundation

/// A head-to-head fantasy matchup for one week.
struct Matchup: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var week: Int
    var userTeam: FantasyTeam
    var opponentTeam: FantasyTeam?
    var userScore: Double?
    var opponentScore: Double?
    var isComplete: Bool
    /// Lineups lock at the first kickoff of the week.
    var lineupLockDate: Date?

    init(
        id: String,
        week: Int,
        userTeam: FantasyTeam,
        opponentTeam: FantasyTeam?,
        userScore: Double? = nil,
        opponentScore: Double? = nil,
        isComplete: Bool = false,
        lineupLockDate: Date? = nil
    ) {
        self.id = id
        self.week = week
        self.userTeam = userTeam
        self.opponentTeam = opponentTeam
        self.userScore = userScore
        self.opponentScore = opponentScore
        self.isComplete = isComplete
        self.lineupLockDate = lineupLockDate
    }

    /// True in leagues or weeks where the user has no opponent (bye week in a
    /// playoff bracket, or an odd-sized league).
    var isBye: Bool { opponentTeam == nil }
}

/// A completed roster move in the league. Useful mainly as a signal that other
/// managers are reacting to something.
struct Transaction: Codable, Hashable, Identifiable, Sendable {
    enum Kind: String, Codable, Sendable {
        case add
        case drop
        case trade
        case waiverClaim
        case lineupChange
    }

    var id: String
    var kind: Kind
    var teamID: String
    var playerIDs: [PlayerID]
    var bidAmount: Int?
    var date: Date

    init(
        id: String,
        kind: Kind,
        teamID: String,
        playerIDs: [PlayerID],
        bidAmount: Int? = nil,
        date: Date
    ) {
        self.id = id
        self.kind = kind
        self.teamID = teamID
        self.playerIDs = playerIDs
        self.bidAmount = bidAmount
        self.date = date
    }
}

/// Where the NFL calendar currently is. Drives which experience the app shows.
enum SeasonPhase: String, Codable, Sendable {
    case preseason
    case regularSeason
    case fantasyPlayoffs
    case offseason

    var displayName: String {
        switch self {
        case .preseason: return "Preseason"
        case .regularSeason: return "Regular Season"
        case .fantasyPlayoffs: return "Playoffs"
        case .offseason: return "Offseason"
        }
    }

    var isInSeason: Bool { self == .regularSeason || self == .fantasyPlayoffs }
}
