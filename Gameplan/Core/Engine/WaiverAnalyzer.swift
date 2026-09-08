import Foundation

/// A scored waiver candidate with the reasoning behind the score.
struct WaiverCandidate: Identifiable, Hashable, Sendable {
    var player: AnalyzedPlayer
    /// 0...1 overall priority for *this* roster.
    var score: Double
    /// Points this player would add to the starting lineup right now.
    var immediateUpgrade: Double
    /// Value beyond this week, weighted by league format.
    var restOfSeasonValue: Double
    var fitsWeakness: Bool
    var suggestedDrop: AnalyzedPlayer?
    var faabRange: ClosedRange<Int>?
    var factors: [RecommendationFactor]

    var id: PlayerID { player.id }
}

/// Ranks the waiver wire against the user's actual roster.
///
/// The explicit design goal is that this must never reduce to "the highest
/// projected available player". A quarterback projected for eighteen points is
/// worthless to a manager who already starts a better one, and a receiver
/// projected for eleven can be the most valuable add on the board if the user's
/// third receiver is scoring five.
struct WaiverAnalyzer {
    var league: League
    var week: Int
    var replacementLevels: [Position: Double]
    var assessments: [Position: PositionAssessment]
    var faabRemaining: Int?
    var deadline: Date?

    init(
        league: League,
        week: Int,
        replacementLevels: [Position: Double],
        assessments: [PositionAssessment],
        faabRemaining: Int?,
        deadline: Date?
    ) {
        self.league = league
        self.week = week
        self.replacementLevels = replacementLevels
        self.assessments = Dictionary(
            assessments.map { ($0.position, $0) },
            uniquingKeysWith: { first, _ in first }
        )
        self.faabRemaining = faabRemaining
        self.deadline = deadline
    }

    func rank(
        pool: [AnalyzedPlayer],
        roster: [AnalyzedPlayer],
        currentLineup: Lineup,
        optimizer: LineupOptimizer,
        players: [PlayerID: AnalyzedPlayer],
        limit: Int = 5
    ) -> [WaiverCandidate] {
        let droppables = dropCandidates(roster: roster, currentLineup: currentLineup)

        return pool
            .filter { !$0.player.isUnavailable(week: week) || restOfSeasonWeight > 0.4 }
            .map { candidate in
                evaluate(
                    candidate: candidate,
                    roster: roster,
                    droppables: droppables,
                    currentLineup: currentLineup,
                    optimizer: optimizer,
                    players: players
                )
            }
            .filter { $0.score > 0.08 }
            .sorted { lhs, rhs in
                lhs.score == rhs.score ? lhs.id.rawValue < rhs.id.rawValue : lhs.score > rhs.score
            }
            .prefix(limit)
            .map { $0 }
    }

    // MARK: - Scoring

    private func evaluate(
        candidate: AnalyzedPlayer,
        roster: [AnalyzedPlayer],
        droppables: [AnalyzedPlayer],
        currentLineup: Lineup,
        optimizer: LineupOptimizer,
        players: [PlayerID: AnalyzedPlayer]
    ) -> WaiverCandidate {
        let position = candidate.position
        let replacement = replacementLevels[position] ?? 0
        let assessment = assessments[position]

        // 1. What this player would actually add to the lineup this week.
        let immediate = immediateUpgrade(
            candidate: candidate,
            currentLineup: currentLineup,
            optimizer: optimizer,
            players: players
        )

        // 2. Value beyond replacement level, which is what matters over a season.
        let overReplacement = candidate.projection.mean - replacement
        let restOfSeason = max(0, overReplacement) * (1 + opportunitySignal(candidate) * 0.8)

        // 3. Does this fix the roster's actual problem?
        let fitsWeakness = assessment?.isWeakness ?? false

        var score = 0.0
        // Immediate lineup impact carries the most weight in a redraft league.
        score += Statistics.remap(immediate, from: 0...8, to: 0...0.42)
        score += Statistics.remap(restOfSeason, from: 0...9, to: 0...0.24) * restOfSeasonWeight * 2.4
        score += opportunitySignal(candidate) * 0.16
        if fitsWeakness { score += 0.14 }
        score += scarcityBonus(for: position)
        score += trendBonus(candidate)
        if candidate.player.isUnavailable(week: week) {
            // Stashing an injured player is only sensible in formats where future
            // value counts for something.
            score *= restOfSeasonWeight
        }
        score = max(0, min(1, score))

        let drop = suggestedDrop(for: candidate, from: droppables)

        return WaiverCandidate(
            player: candidate,
            score: score,
            immediateUpgrade: immediate,
            restOfSeasonValue: restOfSeason,
            fitsWeakness: fitsWeakness,
            suggestedDrop: drop,
            faabRange: faabRange(for: score, immediate: immediate),
            factors: factors(
                for: candidate,
                immediate: immediate,
                overReplacement: overReplacement,
                fitsWeakness: fitsWeakness,
                assessment: assessment
            )
        )
    }

    /// Runs the optimizer with the candidate added to see what the lineup would
    /// actually gain. This is the honest measure — it accounts for the fact that a
    /// good player on a deep roster may not crack the lineup at all.
    private func immediateUpgrade(
        candidate: AnalyzedPlayer,
        currentLineup: Lineup,
        optimizer: LineupOptimizer,
        players: [PlayerID: AnalyzedPlayer]
    ) -> Double {
        var best = 0.0
        for index in currentLineup.assignments.indices {
            let slot = currentLineup.assignments[index].slot
            guard slot.accepts(candidate.position) else { continue }
            let existing = currentLineup.assignments[index].playerID.flatMap { players[$0] }
            let gain = candidate.projection.mean - (existing?.projection.mean ?? 0)
            best = max(best, gain)
        }
        return best
    }

    /// How strong the player's role is, independent of scoring.
    private func opportunitySignal(_ candidate: AnalyzedPlayer) -> Double {
        var signal = candidate.opportunityScore ?? 0.3
        if candidate.trend == .rising { signal += 0.15 }
        if candidate.trend == .falling { signal -= 0.15 }
        if let depth = candidate.player.depthChartRank, depth == 1 { signal += 0.1 }
        // A sharp rise in roster percentage means the rest of the league has
        // noticed, which is both a signal and a warning about the bid price.
        if let change = candidate.player.rosteredPercentageChange, change >= 10 { signal += 0.1 }
        return max(0, min(1, signal))
    }

    /// Positions the league starts many of are worth more on the wire.
    private func scarcityBonus(for position: Position) -> Double {
        let starters = league.leagueWideStarters(at: position)
        switch position {
        case .quarterback:
            return league.isSuperflex ? 0.08 : (starters > 14 ? 0.02 : 0.0)
        case .tightEnd:
            return league.scoring.isTightEndPremium ? 0.07 : 0.04
        case .runningBack:
            return 0.05
        case .wideReceiver:
            return league.scoring.pointsPerReception >= 0.5 ? 0.04 : 0.02
        case .kicker, .defense:
            return -0.06
        }
    }

    private func trendBonus(_ candidate: AnalyzedPlayer) -> Double {
        switch candidate.trend {
        case .rising: return 0.06
        case .falling: return -0.06
        default: return 0
        }
    }

    private var restOfSeasonWeight: Double {
        var weight = league.continuity.futureValueWeight
        // Late in the regular season there is less season left to value.
        let remaining = max(0, league.regularSeasonWeeks - week)
        if league.continuity == .redraft {
            weight *= Statistics.remap(Double(remaining), from: 0...10, to: 0.4...1.0)
        }
        return weight
    }

    // MARK: - Drops

    /// Roster players who can be cut without breaking the lineup, worst first.
    private func dropCandidates(roster: [AnalyzedPlayer], currentLineup: Lineup) -> [AnalyzedPlayer] {
        let starting = currentLineup.startingPlayerIDs
        return roster
            .filter { !starting.contains($0.id) }
            .sorted { lhs, rhs in
                let lhsValue = dropValue(lhs)
                let rhsValue = dropValue(rhs)
                return lhsValue < rhsValue
            }
    }

    /// How much keeping a bench player is worth. Low means safe to cut.
    private func dropValue(_ player: AnalyzedPlayer) -> Double {
        let replacement = replacementLevels[player.position] ?? 0
        var value = player.projection.mean - replacement
        // Being the only backup at a position the league forces you to start is
        // worth something on its own.
        let assessment = assessments[player.position]
        if let assessment, assessment.depthCount <= 1 { value += 2 }
        if player.trend == .rising { value += 1.5 }
        if player.player.injury.status == .injuredReserve { value -= 3 }
        return value
    }

    private func suggestedDrop(for candidate: AnalyzedPlayer, from droppables: [AnalyzedPlayer]) -> AnalyzedPlayer? {
        // Never suggest dropping someone worth more than the player being added.
        droppables.first { drop in
            drop.id != candidate.id && dropValue(drop) < candidate.projection.mean
        } ?? droppables.first
    }

    // MARK: - FAAB

    /// A suggested bid range as a share of the remaining budget.
    ///
    /// This is explicitly a recommendation, not a market price — the app has no
    /// visibility into what anyone else will bid — and the UI labels it as such.
    private func faabRange(for score: Double, immediate: Double) -> ClosedRange<Int>? {
        guard league.waivers.usesFAAB else { return nil }
        let budget = faabRemaining ?? league.waivers.faabBudget ?? 100
        guard budget > 0 else { return 0...0 }

        // A must-add tops out around a third of what is left; a speculative stash
        // is low single digits.
        let share = Statistics.remap(score, from: 0.1...0.85, to: 0.01...0.32)
        let center = Double(budget) * share
        let spread = max(1.0, center * 0.4)
        let low = max(1, Int((center - spread).rounded()))
        let high = max(low + 1, Int((center + spread).rounded()))
        return low...min(budget, high)
    }

    // MARK: - Explanation

    private func factors(
        for candidate: AnalyzedPlayer,
        immediate: Double,
        overReplacement: Double,
        fitsWeakness: Bool,
        assessment: PositionAssessment?
    ) -> [RecommendationFactor] {
        var factors: [RecommendationFactor] = []

        if immediate > 0.5 {
            factors.append(RecommendationFactor(
                id: "waiver-\(candidate.id.rawValue)-upgrade",
                summary: String(format: "Adds about %.1f points to your starting lineup", immediate),
                detail: "Compared against whoever he'd replace in your current lineup.",
                direction: .supporting,
                evidence: .derived
            ))
        } else {
            factors.append(RecommendationFactor(
                id: "waiver-\(candidate.id.rawValue)-noupgrade",
                summary: "Wouldn't crack your starting lineup this week",
                detail: "This is a value add for later, not a fix for Sunday.",
                direction: .neutral,
                evidence: .derived
            ))
        }

        if fitsWeakness, let assessment {
            factors.append(RecommendationFactor(
                id: "waiver-\(candidate.id.rawValue)-fit",
                summary: "Fills your weakest position group",
                detail: assessment.headline,
                direction: .supporting,
                evidence: .derived
            ))
        }

        if overReplacement > 1 {
            factors.append(RecommendationFactor(
                id: "waiver-\(candidate.id.rawValue)-replacement",
                summary: String(format: "%.1f points clear of the next best free agent at %@", overReplacement, candidate.position.abbreviation),
                detail: "Replacement level in a \(league.teamCount)-team league.",
                direction: .supporting,
                evidence: .derived
            ))
        }

        // Carry through the strongest evidence from the projection itself.
        factors.append(contentsOf: candidate.factors.filter { $0.direction == .supporting }.prefix(3))

        if let change = candidate.player.rosteredPercentageChange, change >= 8 {
            factors.append(RecommendationFactor(
                id: "waiver-\(candidate.id.rawValue)-trending",
                summary: "Added in \(Int(change.rounded()))% more leagues this week",
                detail: "Expect competition for him — bid accordingly.",
                direction: .neutral,
                evidence: .measured
            ))
        }

        if candidate.player.injury.status.isUnavailable {
            factors.append(RecommendationFactor(
                id: "waiver-\(candidate.id.rawValue)-injured",
                summary: "Won't play this week",
                detail: "Only worth a roster spot if you can afford to wait.",
                direction: .opposing,
                evidence: .measured
            ))
        }

        return Array(factors.prefix(6))
    }

    // MARK: - Recommendations

    func recommendation(for candidate: WaiverCandidate, rank: Int) -> Recommendation {
        let name = candidate.player.player.fullName
        let priority: RecommendationPriority
        switch candidate.score {
        case 0.55...: priority = .mustDo
        case 0.30..<0.55: priority = .stronglyConsider
        default: priority = .monitor
        }

        var summary: String
        if candidate.immediateUpgrade > 1 {
            summary = String(
                format: "He'd start for you immediately and adds roughly %.1f points to this week's lineup.",
                candidate.immediateUpgrade
            )
        } else if candidate.fitsWeakness {
            summary = "He doesn't start this week, but he's the best available answer to your thinnest position."
        } else {
            summary = "Worth a roster spot for his role and schedule rather than for Sunday."
        }
        if let drop = candidate.suggestedDrop {
            summary += " Drop \(drop.player.shortName) to make room."
        }
        if let range = candidate.faabRange {
            summary += " Suggested bid: $\(range.lowerBound)–$\(range.upperBound)."
        }

        return Recommendation(
            id: "waiver-\(candidate.id.rawValue)",
            action: .add(candidate.id, drop: candidate.suggestedDrop?.id),
            title: rank == 0 ? "Priority pickup: \(name)" : "Add \(name)",
            summary: summary,
            priority: priority,
            confidenceScore: candidate.player.projection.confidence * 0.9,
            factors: candidate.factors,
            winProbabilityDelta: nil,
            risk: risk(for: candidate),
            watchFor: candidate.player.player.injury.requiresMonitoring
                ? "\(candidate.player.player.shortName)'s injury status before you commit budget."
                : "Whether his role holds up for a second week.",
            deadline: deadline,
            deadlineDescription: deadline.map { SeasonCalendar.deadlineDescription(for: $0) },
            category: .waiver
        )
    }

    private func risk(for candidate: WaiverCandidate) -> String? {
        if candidate.player.context.playedGames.count <= 2 {
            return "Small sample — his role could revert as quickly as it appeared."
        }
        if let change = candidate.player.player.rosteredPercentageChange, change >= 15 {
            return "He's being added everywhere, so expect to pay near the top of the suggested range."
        }
        if let drop = candidate.suggestedDrop, drop.projection.mean > candidate.player.projection.mean {
            return "\(drop.player.shortName) currently projects higher, so this is a bet on role over recent scoring."
        }
        return nil
    }
}
