import Foundation

/// One assignment of players to starting slots.
struct Lineup: Hashable, Sendable {
    /// Slot assignments in league lineup order.
    var assignments: [Assignment]
    var mean: Double
    var deviation: Double

    struct Assignment: Hashable, Sendable {
        var slot: RosterSlot
        var playerID: PlayerID?
    }

    var startingPlayerIDs: Set<PlayerID> {
        Set(assignments.compactMap(\.playerID))
    }

    var floor: Double { max(0, mean - 1.15 * deviation) }
    var ceiling: Double { mean + 1.45 * deviation }

    func slot(for id: PlayerID) -> RosterSlot? {
        assignments.first { $0.playerID == id }?.slot
    }
}

/// Chooses the starting lineup that maximises the chance of winning this week.
///
/// This is the heart of the product, and it is deliberately *not* "start the
/// highest projected players". The objective is
/// `P(my score > opponent score)`, which means:
///
/// - When you are already likely to win, the optimizer prefers players who reduce
///   the spread, because a bad week is the only way you lose.
/// - When you are likely to lose, it prefers players who widen it, because an
///   average week loses anyway.
///
/// Nothing about that behaviour is special-cased. It falls out of maximising the
/// probability directly, which is also why it stays sensible in the awkward
/// middle cases where a rule of thumb would not.
struct LineupOptimizer {
    var league: League
    /// The opponent's projected total. Nil in a bye week, where the objective
    /// collapses to maximising expected points.
    var opponent: (mean: Double, deviation: Double)?

    init(league: League, opponent: (mean: Double, deviation: Double)?) {
        self.league = league
        self.opponent = opponent
    }

    /// True when the objective is a win probability rather than raw points.
    var isWinProbabilityObjective: Bool { opponent != nil }

    /// Objective value for a lineup: win probability, or expected points when
    /// there is no opponent to beat.
    func score(_ lineup: Lineup) -> Double {
        guard let opponent else { return lineup.mean }
        return Statistics.probabilityOfExceeding(
            meanA: lineup.mean,
            deviationA: lineup.deviation,
            meanB: opponent.mean,
            deviationB: opponent.deviation
        )
    }

    /// Builds the lineup a manager currently has set, so the app can compare
    /// "what you have" against "what you should have".
    func currentLineup(for team: FantasyTeam, players: [PlayerID: AnalyzedPlayer]) -> Lineup {
        var assignments: [Lineup.Assignment] = []
        var used = Set<PlayerID>()

        for slot in league.lineupSlots {
            let match = team.roster.first { entry in
                entry.slot == slot && !used.contains(entry.id)
            }
            if let match {
                used.insert(match.id)
                assignments.append(Lineup.Assignment(slot: slot, playerID: match.id))
            } else {
                assignments.append(Lineup.Assignment(slot: slot, playerID: nil))
            }
        }

        return finalize(assignments, players: players)
    }

    /// Finds the best legal lineup from everyone available.
    ///
    /// Exhaustive search is not practical — a normal roster admits tens of
    /// thousands of legal lineups — so this greedily seeds a strong lineup and
    /// then improves it with pairwise swaps until no single swap helps. In
    /// practice the search space is small and well-behaved enough that this
    /// reaches the true optimum; where it does not, it is never worse than the
    /// greedy start.
    func optimize(
        candidates: [AnalyzedPlayer],
        players: [PlayerID: AnalyzedPlayer]
    ) -> Lineup {
        let slots = league.lineupSlots
        guard !slots.isEmpty else {
            return Lineup(assignments: [], mean: 0, deviation: 0)
        }

        // Seed: fill the most constrained slots first with the highest mean.
        var remaining = candidates.sorted { $0.projection.mean > $1.projection.mean }
        var assignments: [Lineup.Assignment] = []

        for slot in slots {
            if let index = remaining.firstIndex(where: { slot.accepts($0.position) }) {
                let chosen = remaining.remove(at: index)
                assignments.append(Lineup.Assignment(slot: slot, playerID: chosen.id))
            } else {
                assignments.append(Lineup.Assignment(slot: slot, playerID: nil))
            }
        }

        var best = finalize(assignments, players: players)
        var bestScore = score(best)

        // Local search. Two move types: bench-for-starter, and starter-for-starter
        // between slots (which handles cases like moving a receiver into the flex).
        var improved = true
        var iterations = 0
        while improved && iterations < 12 {
            improved = false
            iterations += 1
            // Recomputed each pass, so a player displaced earlier can come back.
            let benchIDs = candidates
                .map(\.id)
                .filter { !best.startingPlayerIDs.contains($0) }

            for index in best.assignments.indices {
                let slot = best.assignments[index].slot
                for benchID in benchIDs {
                    guard let candidate = players[benchID] else { continue }
                    guard slot.accepts(candidate.position) else { continue }
                    guard !best.startingPlayerIDs.contains(benchID) else { continue }

                    var trial = best.assignments
                    trial[index].playerID = benchID
                    let lineup = finalize(trial, players: players)
                    let trialScore = score(lineup)
                    if trialScore > bestScore + 1e-9 {
                        best = lineup
                        bestScore = trialScore
                        improved = true
                    }
                }
            }

            for first in best.assignments.indices {
                for second in best.assignments.indices where second > first {
                    let firstSlot = best.assignments[first].slot
                    let secondSlot = best.assignments[second].slot
                    guard firstSlot != secondSlot else { continue }
                    let firstID = best.assignments[first].playerID
                    let secondID = best.assignments[second].playerID
                    guard firstID != nil || secondID != nil else { continue }

                    let firstPosition = firstID.flatMap { players[$0]?.position }
                    let secondPosition = secondID.flatMap { players[$0]?.position }
                    if let secondPosition, !firstSlot.accepts(secondPosition) { continue }
                    if let firstPosition, !secondSlot.accepts(firstPosition) { continue }

                    var trial = best.assignments
                    trial[first].playerID = secondID
                    trial[second].playerID = firstID
                    let lineup = finalize(trial, players: players)
                    let trialScore = score(lineup)
                    if trialScore > bestScore + 1e-9 {
                        best = lineup
                        bestScore = trialScore
                        improved = true
                    }
                }
            }
        }

        return best
    }

    /// Recomputes the lineup's distribution after any change.
    func finalize(_ assignments: [Lineup.Assignment], players: [PlayerID: AnalyzedPlayer]) -> Lineup {
        let projections = assignments.compactMap { assignment -> Projection? in
            guard let id = assignment.playerID else { return nil }
            return players[id]?.projection
        }
        let combined = Statistics.combine(
            means: projections.map(\.mean),
            deviations: projections.map(\.standardDeviation)
        )
        return Lineup(assignments: assignments, mean: combined.mean, deviation: combined.deviation)
    }

    /// The change in objective from swapping one player for another in a slot.
    /// Positive means the swap helps.
    func delta(
        from lineup: Lineup,
        replacing outgoing: PlayerID?,
        with incoming: PlayerID?,
        at slotIndex: Int,
        players: [PlayerID: AnalyzedPlayer]
    ) -> Double {
        guard lineup.assignments.indices.contains(slotIndex) else { return 0 }
        var trial = lineup.assignments
        guard trial[slotIndex].playerID == outgoing else { return 0 }
        trial[slotIndex].playerID = incoming
        let candidate = finalize(trial, players: players)
        return score(candidate) - score(lineup)
    }
}
