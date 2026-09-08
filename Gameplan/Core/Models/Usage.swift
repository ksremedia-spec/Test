import Foundation

/// Observed opportunity for a player over a window of games.
///
/// Every field is optional because real data sources are patchy, and the engine
/// must degrade gracefully rather than invent numbers. A nil field means "we do
/// not know", never "zero".
struct PlayerUsage: Codable, Hashable, Sendable {
    /// Number of games this window covers.
    var games: Int
    /// Share of team offensive snaps, 0...1.
    var snapShare: Double?
    /// Share of team pass plays on which the player ran a route, 0...1.
    var routeParticipation: Double?
    /// Share of team targets, 0...1.
    var targetShare: Double?
    var targetsPerGame: Double?
    var carriesPerGame: Double?
    var receptionsPerGame: Double?
    /// Carries plus targets per game.
    var touchesPerGame: Double?
    var redZoneTouchesPerGame: Double?
    var goalLineCarriesPerGame: Double?
    var airYardsPerGame: Double?
    /// Average depth of target, in yards.
    var averageDepthOfTarget: Double?
    var fantasyPointsPerGame: Double?
    /// Points scored per opportunity — separates volume from efficiency.
    var fantasyPointsPerTouch: Double?

    init(
        games: Int = 0,
        snapShare: Double? = nil,
        routeParticipation: Double? = nil,
        targetShare: Double? = nil,
        targetsPerGame: Double? = nil,
        carriesPerGame: Double? = nil,
        receptionsPerGame: Double? = nil,
        touchesPerGame: Double? = nil,
        redZoneTouchesPerGame: Double? = nil,
        goalLineCarriesPerGame: Double? = nil,
        airYardsPerGame: Double? = nil,
        averageDepthOfTarget: Double? = nil,
        fantasyPointsPerGame: Double? = nil,
        fantasyPointsPerTouch: Double? = nil
    ) {
        self.games = games
        self.snapShare = snapShare
        self.routeParticipation = routeParticipation
        self.targetShare = targetShare
        self.targetsPerGame = targetsPerGame
        self.carriesPerGame = carriesPerGame
        self.receptionsPerGame = receptionsPerGame
        self.touchesPerGame = touchesPerGame
        self.redZoneTouchesPerGame = redZoneTouchesPerGame
        self.goalLineCarriesPerGame = goalLineCarriesPerGame
        self.airYardsPerGame = airYardsPerGame
        self.averageDepthOfTarget = averageDepthOfTarget
        self.fantasyPointsPerGame = fantasyPointsPerGame
        self.fantasyPointsPerTouch = fantasyPointsPerTouch
    }

    static let unknown = PlayerUsage()

    var hasData: Bool { games > 0 }

    /// Best available "how involved is this player" signal, 0...1, or nil if we
    /// genuinely have nothing. Prefers the most position-appropriate measure.
    func opportunityScore(for position: Position) -> Double? {
        switch position {
        case .wideReceiver, .tightEnd:
            if let routeParticipation, let targetShare {
                return (routeParticipation * 0.4) + (min(1, targetShare / 0.30) * 0.6)
            }
            if let targetShare { return min(1, targetShare / 0.30) }
            return routeParticipation
        case .runningBack:
            if let snapShare, let touchesPerGame {
                return (snapShare * 0.5) + (min(1, touchesPerGame / 18.0) * 0.5)
            }
            if let touchesPerGame { return min(1, touchesPerGame / 18.0) }
            return snapShare
        case .quarterback:
            return snapShare ?? (games > 0 ? 1.0 : nil)
        case .kicker, .defense:
            return games > 0 ? 1.0 : nil
        }
    }

    /// Combines two windows, preferring whichever has data.
    static func merge(_ recent: PlayerUsage, into season: PlayerUsage) -> PlayerUsage {
        var merged = season
        merged.games = max(season.games, recent.games)
        merged.snapShare = recent.snapShare ?? season.snapShare
        merged.routeParticipation = recent.routeParticipation ?? season.routeParticipation
        merged.targetShare = recent.targetShare ?? season.targetShare
        merged.targetsPerGame = recent.targetsPerGame ?? season.targetsPerGame
        merged.carriesPerGame = recent.carriesPerGame ?? season.carriesPerGame
        merged.receptionsPerGame = recent.receptionsPerGame ?? season.receptionsPerGame
        merged.touchesPerGame = recent.touchesPerGame ?? season.touchesPerGame
        merged.redZoneTouchesPerGame = recent.redZoneTouchesPerGame ?? season.redZoneTouchesPerGame
        merged.goalLineCarriesPerGame = recent.goalLineCarriesPerGame ?? season.goalLineCarriesPerGame
        merged.airYardsPerGame = recent.airYardsPerGame ?? season.airYardsPerGame
        merged.averageDepthOfTarget = recent.averageDepthOfTarget ?? season.averageDepthOfTarget
        merged.fantasyPointsPerGame = recent.fantasyPointsPerGame ?? season.fantasyPointsPerGame
        merged.fantasyPointsPerTouch = recent.fantasyPointsPerTouch ?? season.fantasyPointsPerTouch
        return merged
    }
}

/// A single completed week for a player.
struct GameLogEntry: Codable, Hashable, Identifiable, Sendable {
    var week: Int
    var opponentAbbreviation: String
    var wasHome: Bool
    var fantasyPoints: Double
    var snapShare: Double?
    var targets: Int?
    var carries: Int?
    var receptions: Int?
    var didNotPlay: Bool

    var id: Int { week }

    init(
        week: Int,
        opponentAbbreviation: String,
        wasHome: Bool = true,
        fantasyPoints: Double,
        snapShare: Double? = nil,
        targets: Int? = nil,
        carries: Int? = nil,
        receptions: Int? = nil,
        didNotPlay: Bool = false
    ) {
        self.week = week
        self.opponentAbbreviation = opponentAbbreviation
        self.wasHome = wasHome
        self.fantasyPoints = fantasyPoints
        self.snapShare = snapShare
        self.targets = targets
        self.carries = carries
        self.receptions = receptions
        self.didNotPlay = didNotPlay
    }
}

/// Direction of travel for a player's role.
enum UsageTrend: String, Codable, Sendable {
    case rising
    case steady
    case falling
    case unknown

    var displayName: String {
        switch self {
        case .rising: return "Trending up"
        case .steady: return "Steady role"
        case .falling: return "Trending down"
        case .unknown: return "Not enough data"
        }
    }

    var symbolName: String {
        switch self {
        case .rising: return "arrow.up.right"
        case .steady: return "arrow.right"
        case .falling: return "arrow.down.right"
        case .unknown: return "questionmark"
        }
    }
}
