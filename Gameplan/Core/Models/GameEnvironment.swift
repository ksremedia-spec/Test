import Foundation

/// Weather at kickoff. Only wind and precipitation move fantasy scoring enough to
/// be worth acting on, so those drive the adjustment; temperature is shown for
/// context.
struct WeatherConditions: Codable, Hashable, Sendable {
    var temperatureFahrenheit: Double?
    var windMilesPerHour: Double?
    var precipitationChance: Double?
    var summary: String?

    init(
        temperatureFahrenheit: Double? = nil,
        windMilesPerHour: Double? = nil,
        precipitationChance: Double? = nil,
        summary: String? = nil
    ) {
        self.temperatureFahrenheit = temperatureFahrenheit
        self.windMilesPerHour = windMilesPerHour
        self.precipitationChance = precipitationChance
        self.summary = summary
    }

    /// Wind above roughly 15 mph is the threshold where passing and kicking
    /// production measurably degrades; heavy rain matters less than most people
    /// assume but still nudges game script toward the run.
    var isNoteworthy: Bool {
        if let windMilesPerHour, windMilesPerHour >= 15 { return true }
        if let precipitationChance, precipitationChance >= 0.5 { return true }
        if let temperatureFahrenheit, temperatureFahrenheit <= 20 { return true }
        return false
    }

    var shortDescription: String {
        var parts: [String] = []
        if let temperatureFahrenheit { parts.append("\(Int(temperatureFahrenheit.rounded()))°F") }
        if let windMilesPerHour, windMilesPerHour >= 8 { parts.append("\(Int(windMilesPerHour.rounded())) mph wind") }
        if let precipitationChance, precipitationChance >= 0.3 {
            parts.append("\(Int((precipitationChance * 100).rounded()))% precip")
        }
        if parts.isEmpty { return summary ?? "Clear" }
        return parts.joined(separator: " · ")
    }

    /// Multiplier applied to a passing-game player's projection.
    var passingMultiplier: Double {
        var multiplier = 1.0
        if let wind = windMilesPerHour, wind > 12 {
            multiplier -= min(0.12, (wind - 12) * 0.008)
        }
        if let precipitation = precipitationChance, precipitation > 0.5 {
            multiplier -= (precipitation - 0.5) * 0.06
        }
        return max(0.85, multiplier)
    }

    /// Bad weather shifts volume to the ground game, so rushing is mildly helped.
    var rushingMultiplier: Double {
        let passing = passingMultiplier
        return passing < 1 ? min(1.05, 1 + (1 - passing) * 0.4) : 1.0
    }
}

/// The betting market's view of a game. Highly predictive of fantasy scoring
/// environment when available, and simply omitted when it is not.
struct BettingContext: Codable, Hashable, Sendable {
    /// Total points expected in the game.
    var overUnder: Double?
    /// Spread from the player's team's perspective. Negative means favoured.
    var spread: Double?

    init(overUnder: Double? = nil, spread: Double? = nil) {
        self.overUnder = overUnder
        self.spread = spread
    }

    /// Points the player's own team is expected to score.
    var impliedTeamTotal: Double? {
        guard let overUnder, let spread else { return nil }
        return (overUnder / 2) - (spread / 2)
    }

    /// Trailing teams throw more; leading teams run more.
    var favorsPassing: Bool? {
        guard let spread else { return nil }
        return spread > 3
    }

    var shortDescription: String? {
        guard let impliedTeamTotal else {
            if let overUnder { return "O/U \(String(format: "%.1f", overUnder))" }
            return nil
        }
        return "\(String(format: "%.1f", impliedTeamTotal)) implied team total"
    }
}

/// How a defense has handled a position. `rankAgainstPosition` is 1 (toughest) to
/// 32 (softest) so a high rank is good news for the offensive player.
struct DefensiveMatchup: Codable, Hashable, Sendable {
    var opponentAbbreviation: String
    var rankAgainstPosition: Int?
    var pointsAllowedPerGame: Double?
    var leagueAveragePointsAllowed: Double?

    init(
        opponentAbbreviation: String,
        rankAgainstPosition: Int? = nil,
        pointsAllowedPerGame: Double? = nil,
        leagueAveragePointsAllowed: Double? = nil
    ) {
        self.opponentAbbreviation = opponentAbbreviation
        self.rankAgainstPosition = rankAgainstPosition
        self.pointsAllowedPerGame = pointsAllowedPerGame
        self.leagueAveragePointsAllowed = leagueAveragePointsAllowed
    }

    /// Multiplier in roughly 0.90...1.10. Matchup is real but far weaker than
    /// volume, so it is deliberately capped tight to avoid overstating it.
    var multiplier: Double {
        if let allowed = pointsAllowedPerGame, let average = leagueAveragePointsAllowed, average > 0 {
            return min(1.10, max(0.90, 1 + ((allowed - average) / average) * 0.35))
        }
        guard let rank = rankAgainstPosition else { return 1.0 }
        let normalized = (Double(rank) - 16.5) / 15.5
        return min(1.10, max(0.90, 1 + normalized * 0.08))
    }

    var descriptor: String? {
        guard let rank = rankAgainstPosition else { return nil }
        switch rank {
        case 1...6: return "Tough matchup"
        case 7...13: return "Slightly tough matchup"
        case 14...19: return "Neutral matchup"
        case 20...26: return "Favorable matchup"
        default: return "Great matchup"
        }
    }

    var isFavorable: Bool { (rankAgainstPosition ?? 16) >= 20 }
    var isTough: Bool { (rankAgainstPosition ?? 16) <= 8 }
}

/// Everything about the game a player is about to play.
struct GameEnvironment: Codable, Hashable, Sendable {
    var week: Int
    var kickoff: Date?
    var opponentAbbreviation: String
    var isHome: Bool
    var isIndoor: Bool
    var weather: WeatherConditions?
    var betting: BettingContext
    var defensiveMatchup: DefensiveMatchup?
    /// Team plays per game — pace shapes how much opportunity exists at all.
    var teamPlaysPerGame: Double?
    var teamPassRate: Double?

    init(
        week: Int,
        kickoff: Date? = nil,
        opponentAbbreviation: String,
        isHome: Bool = true,
        isIndoor: Bool = false,
        weather: WeatherConditions? = nil,
        betting: BettingContext = BettingContext(),
        defensiveMatchup: DefensiveMatchup? = nil,
        teamPlaysPerGame: Double? = nil,
        teamPassRate: Double? = nil
    ) {
        self.week = week
        self.kickoff = kickoff
        self.opponentAbbreviation = opponentAbbreviation
        self.isHome = isHome
        self.isIndoor = isIndoor
        self.weather = weather
        self.betting = betting
        self.defensiveMatchup = defensiveMatchup
        self.teamPlaysPerGame = teamPlaysPerGame
        self.teamPassRate = teamPassRate
    }

    /// Weather only applies outdoors.
    var effectiveWeather: WeatherConditions? { isIndoor ? nil : weather }

    var opponentLabel: String {
        isHome ? "vs \(opponentAbbreviation)" : "@ \(opponentAbbreviation)"
    }
}
