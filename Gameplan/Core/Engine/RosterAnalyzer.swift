import Foundation

/// Judges roster strength position by position, relative to what is freely
/// available in *this* league.
///
/// The comparison point is replacement level: the best player at that position
/// the user could add off waivers right now. That is what makes the advice
/// league-aware — a receiver who is a clear starter in a ten-team league can be
/// barely rosterable in a fourteen-team league, and the same roster gets a
/// different verdict in each.
struct RosterAnalyzer {
    var league: League

    init(league: League) {
        self.league = league
    }

    /// Best available projection at each position, used as replacement level.
    ///
    /// When the waiver pool has nothing at a position, the value falls back to a
    /// scarcity-scaled fraction of the league's starting requirement, which keeps
    /// deep leagues from reporting every position as a strength.
    func replacementLevels(waiverPool: [AnalyzedPlayer]) -> [Position: Double] {
        var levels: [Position: Double] = [:]
        for position in Position.allCases {
            let candidates = waiverPool
                .filter { $0.position == position }
                .map(\.projection.mean)
                .sorted(by: >)
            if let best = candidates.first {
                // Averaging the top two damps the effect of one unusual player.
                let secondBest = candidates.dropFirst().first ?? best
                levels[position] = (best * 0.7) + (secondBest * 0.3)
            } else {
                levels[position] = scarcityFallback(for: position)
            }
        }
        return levels
    }

    /// Used only when the waiver pool tells us nothing about a position.
    private func scarcityFallback(for position: Position) -> Double {
        let starters = league.leagueWideStarters(at: position)
        // More league-wide starters means a thinner pool behind them.
        let base: Double
        switch position {
        case .quarterback: return starters > 14 ? 13.0 : 10.0
        case .runningBack: base = 7.5
        case .wideReceiver: base = 7.0
        case .tightEnd: base = 5.0
        case .kicker: return 7.5
        case .defense: return 6.5
        }
        return base * (1 + Double(max(0, starters - 24)) * 0.006)
    }

    /// Position-by-position verdict on the user's roster.
    func assess(
        team: FantasyTeam,
        players: [PlayerID: AnalyzedPlayer],
        replacementLevels: [Position: Double]
    ) -> [PositionAssessment] {
        Position.allCases.compactMap { position -> PositionAssessment? in
            let required = requiredStarters(at: position)
            guard required > 0 else { return nil }

            let roster = team.availableForLineup
                .compactMap { players[$0.id] }
                .filter { $0.position == position }
                .sorted { $0.projection.mean > $1.projection.mean }

            let replacement = replacementLevels[position] ?? 0
            let starters = Array(roster.prefix(required))
            let pointsAboveReplacement = starters.reduce(0) { $0 + ($1.projection.mean - replacement) }

            // Normalise by how much a full starting group is worth, so a one-slot
            // position is not automatically judged less important than a two-slot
            // one. The 0.30 factor is calibrated so that a group sitting a couple
            // of points per week below replacement already reads as thin, which is
            // the point at which it is worth doing something about.
            let scale = max(4.0, replacement * Double(required) * 0.30)
            var strength = max(-1, min(1, pointsAboveReplacement / scale))

            // A missing starter is a hole, not merely a weak spot.
            let shortfall = required - starters.count
            if shortfall > 0 { strength = -1 }

            // Depth matters because injuries happen mid-week.
            let usableDepth = roster.dropFirst(required).filter { $0.projection.mean > replacement * 0.8 }.count
            if usableDepth == 0 && required > 0 { strength -= 0.1 }
            strength = max(-1, min(1, strength))

            return PositionAssessment(
                position: position,
                pointsAboveReplacement: pointsAboveReplacement,
                strengthScore: strength,
                starterCount: starters.count,
                depthCount: max(0, roster.count - required),
                headline: headline(
                    position: position,
                    strength: strength,
                    shortfall: shortfall,
                    depth: usableDepth
                )
            )
        }
    }

    /// How many of this position the user has to field each week, counting a
    /// share of flex slots.
    func requiredStarters(at position: Position) -> Int {
        var dedicated = 0
        var flexSlots = 0
        for (slot, count) in league.startingSlots where slot.isStarting && slot.accepts(position) {
            if slot.eligiblePositions.count == 1 {
                dedicated += count
            } else {
                flexSlots += count
            }
        }
        guard dedicated > 0 || flexSlots > 0 else { return 0 }
        // Flex is usually filled by running backs and receivers, so give those
        // positions the benefit of one extra expected starter.
        let flexShare = (position == .runningBack || position == .wideReceiver) ? flexSlots : 0
        return dedicated + min(flexShare, 1)
    }

    private func headline(
        position: Position,
        strength: Double,
        shortfall: Int,
        depth: Int
    ) -> String {
        if shortfall > 0 {
            return "You're short a startable \(position.abbreviation) this week."
        }
        switch strength {
        case 0.5...:
            return "\(position.abbreviation) is a clear strength — it's where you beat most rosters."
        case 0.25..<0.5:
            return "\(position.abbreviation) is in good shape."
        case -0.25..<0.25:
            if depth == 0 {
                return "\(position.abbreviation) is fine as long as nobody gets hurt — there's nothing behind your starters."
            }
            return "\(position.abbreviation) is adequate."
        case -0.5..<(-0.25):
            return "\(position.abbreviation) is thin. Your starters are barely above what's sitting on waivers."
        default:
            return "\(position.abbreviation) is your weakest group and it's costing you points every week."
        }
    }

    /// The single position most worth fixing: weakest score, tie-broken by how
    /// many points are at stake.
    ///
    /// Kickers and defenses are excluded on purpose. They are streamed weekly and
    /// the spread between the best and worst available is small, so naming one as
    /// "your biggest problem" would be technically defensible and practically
    /// useless — exactly the kind of noise this app exists to remove.
    func biggestWeakness(from assessments: [PositionAssessment]) -> PositionAssessment? {
        assessments
            .filter { $0.isWeakness }
            .filter { $0.position != .kicker && $0.position != .defense }
            .min { lhs, rhs in
                if lhs.strengthScore != rhs.strengthScore { return lhs.strengthScore < rhs.strengthScore }
                return lhs.pointsAboveReplacement < rhs.pointsAboveReplacement
            }
    }
}
