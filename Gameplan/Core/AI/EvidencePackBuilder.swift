import Foundation

/// Assembles the evidence pack from the analysis results.
///
/// Nothing enters the pack that was not produced by the data layer or the
/// calculation layer, which is what allows the validator downstream to be strict.
struct EvidencePackBuilder {
    var league: League
    var week: Int

    init(league: League, week: Int) {
        self.league = league
        self.week = week
    }

    func build(
        matchup: Matchup,
        outlook: MatchupOutlook,
        userLineup: Lineup,
        userPlayers: [PlayerID: AnalyzedPlayer],
        opponentLineup: Lineup?,
        opponentPlayers: [PlayerID: AnalyzedPlayer],
        waiverCandidates: [WaiverCandidate],
        assessments: [PositionAssessment],
        moves: [Recommendation],
        watchItems: [WatchItem],
        dataQuality: DataQuality
    ) -> EvidencePack {
        let rosterFacts = matchup.userTeam.availableForLineup.compactMap { entry -> EvidencePack.PlayerFacts? in
            guard let analyzed = userPlayers[entry.id] else { return nil }
            let slot = userLineup.slot(for: entry.id)?.displayName ?? "Bench"
            return facts(for: analyzed, slot: slot)
        }

        let opponentFacts = (opponentLineup?.assignments ?? []).compactMap { assignment -> EvidencePack.PlayerFacts? in
            guard let id = assignment.playerID, let analyzed = opponentPlayers[id] else { return nil }
            return facts(for: analyzed, slot: assignment.slot.displayName)
        }

        return EvidencePack(
            week: week,
            season: league.season,
            league: EvidencePack.LeagueFacts(
                name: league.name,
                teamCount: league.teamCount,
                scoringFormat: league.scoring.formatName,
                startingLineup: league.lineupSlots.map(\.displayName),
                waiverSystem: league.waivers.displayName,
                faabRemaining: matchup.userTeam.faabRemaining,
                continuity: league.continuity.displayName,
                isPlayoffWeek: league.isPlayoffWeek(week)
            ),
            matchup: EvidencePack.MatchupFacts(
                opponentName: matchup.opponentTeam?.name,
                userRecord: matchup.userTeam.recordLabel,
                opponentRecord: matchup.opponentTeam?.recordLabel,
                winProbability: outlook.winProbability,
                posture: outlook.posture.rawValue,
                projectedPoints: rounded(outlook.projectedPoints),
                projectedOpponentPoints: rounded(outlook.projectedOpponentPoints),
                projectedFloor: rounded(outlook.projectedFloor),
                projectedCeiling: rounded(outlook.projectedCeiling),
                positionMargins: Dictionary(
                    outlook.positionAdvantages.map { ($0.position.abbreviation, rounded($0.margin)) },
                    uniquingKeysWith: { first, _ in first }
                )
            ),
            roster: rosterFacts,
            opponentStarters: opponentFacts,
            waiverCandidates: waiverCandidates.map { facts(for: $0.player, slot: nil) },
            positionAssessments: assessments.map {
                EvidencePack.PositionFacts(
                    position: $0.position.abbreviation,
                    verdict: $0.descriptor,
                    pointsAboveReplacement: rounded($0.pointsAboveReplacement),
                    starterCount: $0.starterCount,
                    depthCount: $0.depthCount
                )
            },
            proposedMoves: moves.map {
                EvidencePack.MoveFacts(
                    id: $0.id,
                    action: $0.action.verb,
                    title: $0.title,
                    priority: $0.priority.rawValue,
                    winProbabilityDelta: $0.winProbabilityDelta.map { rounded($0 * 100) / 100 },
                    supportingEvidence: $0.supportingFactors.map(\.summary),
                    opposingEvidence: $0.opposingFactors.map(\.summary)
                )
            },
            watchItems: watchItems.map {
                EvidencePack.WatchFacts(title: $0.title, detail: $0.detail, contingency: $0.contingency)
            },
            dataGaps: dataQuality.notes
        )
    }

    private func facts(for analyzed: AnalyzedPlayer, slot: String?) -> EvidencePack.PlayerFacts {
        let usage = analyzed.context.bestUsage
        return EvidencePack.PlayerFacts(
            id: analyzed.id.rawValue,
            name: analyzed.player.fullName,
            position: analyzed.position.abbreviation,
            team: analyzed.player.teamAbbreviation,
            opponent: analyzed.context.environment?.opponentLabel,
            slot: slot,
            status: analyzed.player.injury.summary,
            projectedPoints: rounded(analyzed.projection.mean),
            floor: rounded(analyzed.projection.floor),
            ceiling: rounded(analyzed.projection.ceiling),
            projectionSource: analyzed.projection.source.rawValue,
            confidence: rounded(analyzed.projection.confidence * 100) / 100,
            snapShare: usage.snapShare.map { rounded($0 * 100) / 100 },
            routeParticipation: usage.routeParticipation.map { rounded($0 * 100) / 100 },
            targetShare: usage.targetShare.map { rounded($0 * 100) / 100 },
            touchesPerGame: usage.touchesPerGame.map { rounded($0) },
            pointsPerGameSeason: analyzed.context.seasonUsage.fantasyPointsPerGame.map { rounded($0) },
            pointsPerGameRecent: analyzed.context.recentUsage.fantasyPointsPerGame.map { rounded($0) },
            trend: analyzed.trend.rawValue,
            matchupRank: analyzed.context.environment?.defensiveMatchup?.rankAgainstPosition,
            weather: analyzed.context.environment?.effectiveWeather?.shortDescription
        )
    }

    private func rounded(_ value: Double) -> Double {
        (value * 10).rounded() / 10
    }
}
