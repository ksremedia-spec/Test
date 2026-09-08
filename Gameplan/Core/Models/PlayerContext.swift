import Foundation

/// Everything the engine knows about one player for one week: identity, observed
/// opportunity, the game they are walking into, and any published projection.
///
/// This is the unit of *fact*. Analysis never mutates it — analysers read a
/// `PlayerContext` and emit separate result types — which keeps the boundary
/// between facts, calculation and interpretation clean and auditable.
struct PlayerContext: Codable, Hashable, Identifiable, Sendable {
    var player: Player
    /// Last three games, when available.
    var recentUsage: PlayerUsage
    /// Season to date.
    var seasonUsage: PlayerUsage
    var gameLog: [GameLogEntry]
    var environment: GameEnvironment?
    /// A projection published by the fantasy platform, if it supplied one.
    var providerProjectedPoints: Double?
    var news: [NewsItem]

    var id: PlayerID { player.id }

    init(
        player: Player,
        recentUsage: PlayerUsage = .unknown,
        seasonUsage: PlayerUsage = .unknown,
        gameLog: [GameLogEntry] = [],
        environment: GameEnvironment? = nil,
        providerProjectedPoints: Double? = nil,
        news: [NewsItem] = []
    ) {
        self.player = player
        self.recentUsage = recentUsage
        self.seasonUsage = seasonUsage
        self.gameLog = gameLog
        self.environment = environment
        self.providerProjectedPoints = providerProjectedPoints
        self.news = news
    }

    var position: Position { player.position }

    /// Recent usage where present, backfilled from the season window.
    var bestUsage: PlayerUsage { PlayerUsage.merge(recentUsage, into: seasonUsage) }

    var playedGames: [GameLogEntry] { gameLog.filter { !$0.didNotPlay } }

    /// Direction of the player's role, judged on snap share first and fantasy
    /// output second. Needs at least three games to say anything.
    var usageTrend: UsageTrend {
        let played = playedGames.sorted { $0.week < $1.week }
        guard played.count >= 3 else { return .unknown }
        let recent = Array(played.suffix(3))
        let earlier = Array(played.dropLast(3))
        guard !earlier.isEmpty else { return .steady }

        if let recentSnaps = average(recent.compactMap(\.snapShare)),
           let earlierSnaps = average(earlier.compactMap(\.snapShare)),
           abs(recentSnaps - earlierSnaps) > 0.08 {
            return recentSnaps > earlierSnaps ? .rising : .falling
        }

        let recentPoints = average(recent.map(\.fantasyPoints)) ?? 0
        let earlierPoints = average(earlier.map(\.fantasyPoints)) ?? 0
        guard earlierPoints > 1 else { return .steady }
        let change = (recentPoints - earlierPoints) / earlierPoints
        if change > 0.25 { return .rising }
        if change < -0.25 { return .falling }
        return .steady
    }

    /// Standard deviation of realised weekly scores. Preferred over a model
    /// assumption whenever there are enough games to mean anything.
    var observedScoringDeviation: Double? {
        let scores = playedGames.map(\.fantasyPoints)
        guard scores.count >= 4 else { return nil }
        let mean = scores.reduce(0, +) / Double(scores.count)
        let sumSquares = scores.reduce(0) { $0 + ($1 - mean) * ($1 - mean) }
        return (sumSquares / Double(scores.count - 1)).squareRoot()
    }

    var significantNews: [NewsItem] {
        news.filter { $0.impact >= .notable && $0.isRecent() }
            .sorted { $0.publishedAt > $1.publishedAt }
    }

    func isUnavailable(week: Int) -> Bool { player.isUnavailable(week: week) }

    private func average(_ values: [Double]) -> Double? {
        guard !values.isEmpty else { return nil }
        return values.reduce(0, +) / Double(values.count)
    }
}
