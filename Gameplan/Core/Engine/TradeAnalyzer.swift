import Foundation

/// Looks for trades that convert roster surplus into roster need.
///
/// The app deliberately does not pretend to know trade *values* — that depends on
/// what other managers believe, which is not in any dataset here. What it can
/// establish rigorously is structural: which positions this roster is deep at,
/// which it is thin at, and whether consolidating one into the other would
/// actually improve the weekly starting lineup. Every trade idea it produces is
/// framed as a direction to explore, never as a price.
struct TradeAnalyzer {
    var league: League
    var week: Int
    var replacementLevels: [Position: Double]

    init(league: League, week: Int, replacementLevels: [Position: Double]) {
        self.league = league
        self.week = week
        self.replacementLevels = replacementLevels
    }

    func recommendations(
        assessments: [PositionAssessment],
        roster: [AnalyzedPlayer],
        currentLineup: Lineup,
        limit: Int = 1
    ) -> [Recommendation] {
        guard isTradeWindowOpen else { return [] }

        let strengths = assessments.filter { $0.isStrength && $0.depthCount >= 2 }
        let weaknesses = assessments.filter { $0.isWeakness }

        guard let need = weaknesses.min(by: { $0.strengthScore < $1.strengthScore }) else { return [] }
        guard let surplus = strengths.max(by: { $0.pointsAboveReplacement < $1.pointsAboveReplacement }) else {
            return []
        }
        guard surplus.position != need.position else { return [] }

        // The trade piece is the best player at the surplus position who is not
        // needed in the starting lineup.
        let starting = currentLineup.startingPlayerIDs
        let spare = roster
            .filter { $0.position == surplus.position && !starting.contains($0.id) }
            .sorted { $0.projection.mean > $1.projection.mean }

        guard let piece = spare.first else { return [] }
        let replacement = replacementLevels[surplus.position] ?? 0
        // Only worth trading if the bench player is genuinely valuable to someone.
        guard piece.projection.mean > replacement + 2 else { return [] }

        let recommendation = Recommendation(
            id: "trade-\(surplus.position.rawValue)-\(need.position.rawValue)",
            action: .exploreTrade(give: [piece.id], targetPosition: need.position),
            title: "Trade from \(surplus.position.abbreviation) depth into \(need.position.abbreviation)",
            summary: "\(piece.player.fullName) is your most valuable player who isn't starting. Shopping him for a \(need.position.abbreviation) upgrade turns a bench asset into weekly points.",
            priority: .stronglyConsider,
            confidenceScore: 0.5,
            factors: [
                RecommendationFactor(
                    id: "trade-surplus",
                    summary: "\(surplus.position.abbreviation) is your deepest position",
                    detail: surplus.headline,
                    direction: .supporting,
                    evidence: .derived
                ),
                RecommendationFactor(
                    id: "trade-need",
                    summary: "\(need.position.abbreviation) is your weakest",
                    detail: need.headline,
                    direction: .supporting,
                    evidence: .derived
                ),
                RecommendationFactor(
                    id: "trade-bench",
                    summary: String(
                        format: "%@ projects for %.1f points and isn't in your lineup",
                        piece.player.shortName, piece.projection.mean
                    ),
                    detail: "Points on your bench don't count. Points in your lineup do.",
                    direction: .supporting,
                    evidence: .derived
                ),
                RecommendationFactor(
                    id: "trade-caveat",
                    summary: "Gameplan can't price this trade",
                    detail: "What a manager will accept depends on their roster and their read on the players, not on anything in this data. Treat this as a direction, not an offer.",
                    direction: .neutral,
                    evidence: .estimated
                )
            ],
            winProbabilityDelta: nil,
            risk: "Trading depth means an injury at \(surplus.position.abbreviation) hurts more. Only move him if the return actually starts for you.",
            watchFor: "Managers who are thin at \(surplus.position.abbreviation) — they're your best trade partners.",
            deadline: tradeDeadline,
            deadlineDescription: league.tradeDeadlineWeek.map { "Trade deadline: week \($0)" },
            category: .trade
        )

        return Array([recommendation].prefix(limit))
    }

    private var isTradeWindowOpen: Bool {
        guard let deadlineWeek = league.tradeDeadlineWeek else { return true }
        return week < deadlineWeek
    }

    private var tradeDeadline: Date? { nil }
}
