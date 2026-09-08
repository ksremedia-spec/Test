import Foundation

/// Builds the head-to-head picture: how likely the user is to win, where the
/// edges are, and which players decide it.
struct MatchupAnalyzer {
    var league: League
    var week: Int

    init(league: League, week: Int) {
        self.league = league
        self.week = week
    }

    /// The opponent's projected total, assuming they set their best lineup.
    ///
    /// Assuming optimal play is the conservative choice: it never flatters the
    /// user's position, so advice built on it does not quietly depend on the
    /// opponent making a mistake.
    func opponentProjection(
        team: FantasyTeam,
        players: [PlayerID: AnalyzedPlayer]
    ) -> (mean: Double, deviation: Double, lineup: Lineup) {
        let optimizer = LineupOptimizer(league: league, opponent: nil)
        let candidates = team.availableForLineup.compactMap { players[$0.id] }
        let lineup = optimizer.optimize(candidates: candidates, players: players)
        return (lineup.mean, lineup.deviation, lineup)
    }

    func outlook(
        userLineup: Lineup,
        opponent: (mean: Double, deviation: Double)?,
        userPlayers: [PlayerID: AnalyzedPlayer],
        opponentLineup: Lineup?,
        opponentPlayers: [PlayerID: AnalyzedPlayer]
    ) -> MatchupOutlook {
        let opponentMean = opponent?.mean ?? 0
        let opponentDeviation = opponent?.deviation ?? 0

        let winProbability: Double
        if opponent == nil {
            // No opponent this week — a bye in the bracket, or an odd league size.
            winProbability = 1.0
        } else {
            winProbability = Statistics.probabilityOfExceeding(
                meanA: userLineup.mean,
                deviationA: userLineup.deviation,
                meanB: opponentMean,
                deviationB: opponentDeviation
            )
        }

        return MatchupOutlook(
            winProbability: winProbability,
            projectedPoints: userLineup.mean,
            projectedOpponentPoints: opponentMean,
            projectedFloor: userLineup.floor,
            projectedCeiling: userLineup.ceiling,
            opponentFloor: max(0, opponentMean - 1.15 * opponentDeviation),
            opponentCeiling: opponentMean + 1.45 * opponentDeviation,
            positionAdvantages: advantages(
                userLineup: userLineup,
                userPlayers: userPlayers,
                opponentLineup: opponentLineup,
                opponentPlayers: opponentPlayers
            )
        )
    }

    private func advantages(
        userLineup: Lineup,
        userPlayers: [PlayerID: AnalyzedPlayer],
        opponentLineup: Lineup?,
        opponentPlayers: [PlayerID: AnalyzedPlayer]
    ) -> [PositionAdvantage] {
        guard let opponentLineup else { return [] }

        // Group by the player's actual position rather than by slot, so a receiver
        // in the flex is compared against receivers.
        func totals(_ lineup: Lineup, _ players: [PlayerID: AnalyzedPlayer]) -> [Position: (mean: Double, ceiling: Double)] {
            var result: [Position: (mean: Double, ceiling: Double)] = [:]
            for assignment in lineup.assignments {
                guard let id = assignment.playerID, let player = players[id] else { continue }
                var current = result[player.position] ?? (0, 0)
                current.mean += player.projection.mean
                current.ceiling += player.projection.ceiling
                result[player.position] = current
            }
            return result
        }

        let mine = totals(userLineup, userPlayers)
        let theirs = totals(opponentLineup, opponentPlayers)
        let positions = Set(mine.keys).union(theirs.keys)

        return positions
            .map { position in
                PositionAdvantage(
                    position: position,
                    userProjected: mine[position]?.mean ?? 0,
                    opponentProjected: theirs[position]?.mean ?? 0,
                    userCeiling: mine[position]?.ceiling ?? 0,
                    opponentCeiling: theirs[position]?.ceiling ?? 0
                )
            }
            .sorted { $0.position.displayOrder < $1.position.displayOrder }
    }

    /// The players whose outcome most decides the matchup: highest spread between
    /// their own floor and ceiling, on either roster.
    func swingPlayers(
        userLineup: Lineup,
        userPlayers: [PlayerID: AnalyzedPlayer],
        opponentLineup: Lineup?,
        opponentPlayers: [PlayerID: AnalyzedPlayer],
        limit: Int = 3
    ) -> [AnalyzedPlayer] {
        var all: [AnalyzedPlayer] = userLineup.assignments.compactMap { assignment in
            assignment.playerID.flatMap { userPlayers[$0] }
        }
        if let opponentLineup {
            all += opponentLineup.assignments.compactMap { assignment in
                assignment.playerID.flatMap { opponentPlayers[$0] }
            }
        }
        return all
            .sorted { ($0.projection.ceiling - $0.projection.floor) > ($1.projection.ceiling - $1.projection.floor) }
            .prefix(limit)
            .map { $0 }
    }
}
