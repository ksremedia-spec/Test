import Foundation

/// Produces lineup recommendations by comparing the user's current lineup with
/// the one that maximises their chance of winning.
///
/// Rather than reporting the optimal lineup wholesale, it decomposes the
/// difference into individual swaps and scores each one by how much win
/// probability it is actually worth. That is what lets the app say "this move
/// matters, that one doesn't" instead of listing nine changes of equal weight.
struct StartSitAnalyzer {
    var league: League
    var week: Int
    var optimizer: LineupOptimizer
    var posture: WeeklyPosture
    var deadline: Date?

    init(
        league: League,
        week: Int,
        optimizer: LineupOptimizer,
        posture: WeeklyPosture,
        deadline: Date?
    ) {
        self.league = league
        self.week = week
        self.optimizer = optimizer
        self.posture = posture
        self.deadline = deadline
    }

    func recommendations(
        current: Lineup,
        optimal: Lineup,
        players: [PlayerID: AnalyzedPlayer]
    ) -> [Recommendation] {
        var recommendations: [Recommendation] = []
        var working = current

        let currentStarters = current.startingPlayerIDs
        let optimalStarters = optimal.startingPlayerIDs

        // The advice is the *difference* between the two lineups, not a slot-by-slot
        // walk: a player can be in a different slot in each without that being a
        // change worth telling anyone about. So take the players who join the
        // lineup, and pair each with the player they displace.
        let incoming = optimalStarters.subtracting(currentStarters)
            .compactMap { players[$0] }
            // Set iteration order is undefined, so the tie-break on ID is what
            // makes the resulting advice identical run to run.
            .sorted { lhs, rhs in
                lhs.projection.mean == rhs.projection.mean
                    ? lhs.id.rawValue < rhs.id.rawValue
                    : lhs.projection.mean > rhs.projection.mean
            }

        // Applying each accepted swap to the working lineup means later deltas are
        // measured against the improved lineup, so the reported gains add up
        // instead of double-counting.
        for candidate in incoming {
            guard let slotIndex = displacementIndex(
                for: candidate,
                in: working,
                optimal: optimal,
                optimalStarters: optimalStarters,
                players: players
            ) else { continue }

            var trial = working.assignments
            let outgoingID = trial[slotIndex].playerID
            trial[slotIndex].playerID = candidate.id
            let slot = trial[slotIndex].slot

            let updated = optimizer.finalize(trial, players: players)
            let delta = optimizer.score(updated) - optimizer.score(working)
            // The objective is a probability when there is an opponent and raw
            // points when there is not, so the threshold has to match its units.
            let threshold = optimizer.isWinProbabilityObjective ? 0.002 : 0.25
            guard delta > threshold else { continue }

            let outgoing = outgoingID.flatMap { players[$0] }
            recommendations.append(swapRecommendation(
                incoming: candidate,
                outgoing: outgoing,
                slot: slot,
                delta: delta,
                pointsDelta: candidate.projection.mean - (outgoing?.projection.mean ?? 0)
            ))
            working = updated
        }

        // Any slot that stays empty is a slot scoring zero, which the user needs
        // to know about even though there is nothing on the roster to fix it.
        for assignment in working.assignments where assignment.playerID == nil {
            recommendations.append(emptySlotRecommendation(slot: assignment.slot))
        }

        return recommendations
    }

    /// Which slot an incoming player should take over.
    ///
    /// Preference goes to the slot they occupy in the optimal lineup, because that
    /// is the pairing the optimizer actually intended. Displacing a player who is
    /// *also* in the optimal lineup is never allowed — that would recommend
    /// benching someone the app is about to recommend starting.
    private func displacementIndex(
        for candidate: AnalyzedPlayer,
        in working: Lineup,
        optimal: Lineup,
        optimalStarters: Set<PlayerID>,
        players: [PlayerID: AnalyzedPlayer]
    ) -> Int? {
        func isDisplaceable(_ index: Int) -> Bool {
            let slot = working.assignments[index].slot
            guard slot.accepts(candidate.position) else { return false }
            guard let occupant = working.assignments[index].playerID else { return true }
            return !optimalStarters.contains(occupant)
        }

        func weakestOccupant(among indices: [Int]) -> Int? {
            indices.min { lhs, rhs in
                let left = working.assignments[lhs].playerID.flatMap { players[$0]?.projection.mean } ?? -1
                let right = working.assignments[rhs].playerID.flatMap { players[$0]?.projection.mean } ?? -1
                return left < right
            }
        }

        let preferredSlot = optimal.slot(for: candidate.id)
        let preferred = working.assignments.indices.filter {
            working.assignments[$0].slot == preferredSlot && isDisplaceable($0)
        }
        if let index = weakestOccupant(among: Array(preferred)) { return index }

        // The intended slot is unavailable, so fall back to any legal slot whose
        // occupant is on the way out anyway.
        return weakestOccupant(among: working.assignments.indices.filter(isDisplaceable))
    }

    /// A short, explicit confirmation when the lineup is already right. Without
    /// this the user cannot tell "no advice" from "we didn't check".
    func confirmationRecommendation(current: Lineup, players: [PlayerID: AnalyzedPlayer]) -> Recommendation {
        let starters = current.assignments
            .compactMap { $0.playerID.flatMap { players[$0] } }
            .sorted { $0.projection.mean > $1.projection.mean }

        var factors: [RecommendationFactor] = [
            RecommendationFactor(
                id: "lineup-optimal",
                summary: "Every slot already holds your best option",
                detail: "Gameplan compared your lineup against every legal alternative from your bench.",
                direction: .supporting,
                evidence: .derived
            )
        ]
        if let best = starters.first {
            factors.append(RecommendationFactor(
                id: "lineup-anchor",
                summary: "\(best.player.fullName) leads your lineup at \(String(format: "%.1f", best.projection.mean)) projected points",
                direction: .supporting,
                evidence: best.projection.source
            ))
        }

        return Recommendation(
            id: "lineup-no-action",
            action: .none,
            title: "Your lineup is already optimal",
            summary: "No changes needed. \(posture.strategyStatement)",
            priority: .noAction,
            confidenceScore: 0.8,
            factors: factors,
            winProbabilityDelta: 0,
            risk: nil,
            watchFor: "Injury news can change this before kickoff.",
            deadline: deadline,
            deadlineDescription: deadline.map { SeasonCalendar.deadlineDescription(for: $0) },
            category: .lineup
        )
    }

    // MARK: - Building the recommendation

    private func swapRecommendation(
        incoming: AnalyzedPlayer,
        outgoing: AnalyzedPlayer?,
        slot: RosterSlot,
        delta: Double,
        pointsDelta: Double
    ) -> Recommendation {
        let title: String
        let summary: String
        let action: RecommendationAction

        if let outgoing {
            title = "Start \(incoming.player.fullName) over \(outgoing.player.fullName)"
            summary = comparisonSummary(incoming: incoming, outgoing: outgoing, pointsDelta: pointsDelta)
            action = .swap(promote: incoming.id, demote: outgoing.id, slot: slot)
        } else {
            title = "Start \(incoming.player.fullName) at \(slot.displayName)"
            summary = "You have an empty \(slot.displayName) slot and \(incoming.player.shortName) is your best option for it."
            action = .moveToSlot(incoming.id, slot: slot)
        }

        var factors = incoming.factors.filter { $0.direction != .neutral }
        if let outgoing {
            factors.append(contentsOf: outgoing.factors
                .filter { $0.direction == .supporting }
                .prefix(2)
                .map { factor in
                    RecommendationFactor(
                        id: "against-\(factor.id)",
                        summary: "\(outgoing.player.shortName): \(factor.summary)",
                        detail: factor.detail,
                        direction: .opposing,
                        evidence: factor.evidence
                    )
                })
        }
        factors.insert(postureFactor(incoming: incoming, outgoing: outgoing), at: 0)

        let priority: RecommendationPriority
        if optimizer.isWinProbabilityObjective {
            switch delta {
            case 0.04...: priority = .mustDo
            case 0.015..<0.04: priority = .stronglyConsider
            default: priority = .monitor
            }
        } else {
            // Without an opponent the delta is expected points.
            switch delta {
            case 3...: priority = .mustDo
            case 1..<3: priority = .stronglyConsider
            default: priority = .monitor
            }
        }

        let confidence = min(incoming.projection.confidence, outgoing?.projection.confidence ?? 1)

        return Recommendation(
            id: "start-\(incoming.id.rawValue)-\(slot.rawValue)",
            action: action,
            title: title,
            summary: summary,
            priority: priority,
            confidenceScore: confidence,
            factors: Array(factors.prefix(6)),
            winProbabilityDelta: optimizer.isWinProbabilityObjective ? delta : nil,
            risk: riskStatement(incoming: incoming, outgoing: outgoing, pointsDelta: pointsDelta),
            watchFor: watchStatement(incoming: incoming, outgoing: outgoing),
            deadline: deadline,
            deadlineDescription: deadline.map { SeasonCalendar.deadlineDescription(for: $0) },
            category: .lineup
        )
    }

    private func comparisonSummary(incoming: AnalyzedPlayer, outgoing: AnalyzedPlayer, pointsDelta: Double) -> String {
        if abs(pointsDelta) < 1.0 {
            // The projections are close, so the reason must be the shape of the
            // distributions rather than the expectation.
            if posture.favorsCeiling {
                return "Nearly identical projections, but \(incoming.player.shortName) has the higher ceiling — and you need the upside this week."
            }
            if posture.favorsFloor {
                return "Nearly identical projections, but \(incoming.player.shortName) is the safer of the two — and you don't need to take a swing."
            }
            return "It's close, but \(incoming.player.shortName) edges it on the underlying evidence."
        }
        return String(
            format: "%@ projects about %.1f points higher than %@ this week.",
            incoming.player.shortName, abs(pointsDelta), outgoing.player.shortName
        )
    }

    /// States plainly why the strategic posture pushed the decision one way.
    private func postureFactor(incoming: AnalyzedPlayer, outgoing: AnalyzedPlayer?) -> RecommendationFactor {
        let summary: String
        switch posture {
        case .heavyFavorite, .favorite:
            summary = "You're favored, so the safer option is worth more than the bigger one"
        case .tossUp:
            summary = "This matchup is a coin flip, so the highest expected points wins"
        case .underdog, .heavyUnderdog:
            summary = "You're an underdog, so upside is worth more than a safe floor"
        }
        var detail = posture.strategyStatement
        if let outgoing {
            detail += String(
                format: " %@: %.1f floor / %.1f ceiling. %@: %.1f floor / %.1f ceiling.",
                incoming.player.shortName, incoming.projection.floor, incoming.projection.ceiling,
                outgoing.player.shortName, outgoing.projection.floor, outgoing.projection.ceiling
            )
        }
        return RecommendationFactor(
            id: "posture-\(incoming.id.rawValue)",
            summary: summary,
            detail: detail,
            direction: .supporting,
            evidence: .derived
        )
    }

    private func riskStatement(incoming: AnalyzedPlayer, outgoing: AnalyzedPlayer?, pointsDelta: Double) -> String? {
        if incoming.player.injury.status.isUncertain {
            return "\(incoming.player.shortName) is \(incoming.player.injury.status.displayName.lowercased()) — if he's ruled out you'll need a replacement before kickoff."
        }
        if let outgoing, outgoing.projection.ceiling > incoming.projection.ceiling + 3 {
            return String(
                format: "%@ has the higher ceiling (%.1f against %.1f), so this trades upside for reliability.",
                outgoing.player.shortName, outgoing.projection.ceiling, incoming.projection.ceiling
            )
        }
        if incoming.projection.confidence < 0.45 {
            return "This one rests on limited data, so treat it as a lean rather than a certainty."
        }
        if abs(pointsDelta) < 1.5 {
            return "The two are close enough that either could outscore the other on any given week."
        }
        return nil
    }

    private func watchStatement(incoming: AnalyzedPlayer, outgoing: AnalyzedPlayer?) -> String? {
        if incoming.player.injury.requiresMonitoring {
            return "\(incoming.player.shortName)'s status before kickoff."
        }
        if let outgoing, outgoing.player.injury.requiresMonitoring {
            return "\(outgoing.player.shortName)'s status — if he's ruled out, this becomes automatic."
        }
        if let weather = incoming.context.environment?.effectiveWeather, weather.isNoteworthy {
            return "Conditions at \(incoming.context.environment?.opponentLabel ?? "the game") — \(weather.shortDescription)."
        }
        return nil
    }

    private func emptySlotRecommendation(slot: RosterSlot) -> Recommendation {
        Recommendation(
            id: "empty-\(slot.rawValue)",
            action: .none,
            title: "You have an empty \(slot.displayName) slot",
            summary: "Nobody on your roster can legally fill \(slot.displayName) this week. You're giving up those points unless you add someone.",
            priority: .mustDo,
            confidenceScore: 0.95,
            factors: [
                RecommendationFactor(
                    id: "empty-\(slot.rawValue)-factor",
                    summary: "An empty starting slot scores zero",
                    detail: "Byes and injuries are the usual cause.",
                    direction: .opposing,
                    evidence: .measured
                )
            ],
            winProbabilityDelta: nil,
            risk: nil,
            watchFor: "Check waivers for anyone who can fill this slot.",
            deadline: deadline,
            deadlineDescription: deadline.map { SeasonCalendar.deadlineDescription(for: $0) },
            category: .lineup
        )
    }
}
