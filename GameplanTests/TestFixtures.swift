import Foundation
@testable import Gameplan

/// Builders for the small, explicit fixtures the engine tests use.
///
/// Deliberately hand-built rather than pulled from the demo league: a test that
/// depends on the demo data breaks whenever the demo is tuned, which is exactly
/// the kind of brittleness that makes a suite stop being trusted.
enum Fixtures {

    static func player(
        id: String,
        name: String = "Test Player",
        position: Position = .wideReceiver,
        team: String = "BUF",
        injury: InjuryReport = .healthy,
        byeWeek: Int? = nil,
        depthChartRank: Int? = 1,
        rostered: Double? = 0.5,
        rosteredChange: Double? = nil
    ) -> Player {
        let parts = name.split(separator: " ", maxSplits: 1)
        return Player(
            id: PlayerID(source: "test", value: id),
            firstName: parts.count > 1 ? String(parts[0]) : "",
            lastName: parts.count > 1 ? String(parts[1]) : name,
            position: position,
            teamAbbreviation: team,
            byeWeek: byeWeek,
            injury: injury,
            depthChartRank: depthChartRank,
            rosteredPercentage: rostered,
            rosteredPercentageChange: rosteredChange
        )
    }

    static func context(
        id: String,
        name: String = "Test Player",
        position: Position = .wideReceiver,
        team: String = "BUF",
        projection: Double? = 12,
        pointsPerGame: Double = 12,
        games: Int = 6,
        scores: [Double]? = nil,
        injury: InjuryReport = .healthy,
        byeWeek: Int? = nil,
        opponent: String = "MIA",
        matchupRank: Int? = nil,
        weather: WeatherConditions? = nil,
        snapShare: Double? = 0.75,
        targetShare: Double? = 0.2,
        depthChartRank: Int? = 1,
        rosteredChange: Double? = nil,
        week: Int = 7
    ) -> PlayerContext {
        let gameLog = (scores ?? Array(repeating: pointsPerGame, count: games))
            .enumerated()
            .map { index, points in
                GameLogEntry(
                    week: index + 1,
                    opponentAbbreviation: opponent,
                    fantasyPoints: points,
                    snapShare: snapShare
                )
            }

        let usage = PlayerUsage(
            games: gameLog.count,
            snapShare: snapShare,
            routeParticipation: position.isReceivingDriven ? snapShare : nil,
            targetShare: targetShare,
            targetsPerGame: targetShare.map { $0 * 35 },
            carriesPerGame: position == .runningBack ? 12 : nil,
            touchesPerGame: position == .runningBack ? 15 : targetShare.map { $0 * 35 },
            fantasyPointsPerGame: pointsPerGame
        )

        return PlayerContext(
            player: player(
                id: id,
                name: name,
                position: position,
                team: team,
                injury: injury,
                byeWeek: byeWeek,
                depthChartRank: depthChartRank,
                rosteredChange: rosteredChange
            ),
            recentUsage: usage,
            seasonUsage: usage,
            gameLog: gameLog,
            environment: GameEnvironment(
                week: week,
                kickoff: Date().addingTimeInterval(3 * 24 * 3600),
                opponentAbbreviation: opponent,
                isHome: true,
                isIndoor: false,
                weather: weather,
                defensiveMatchup: matchupRank.map {
                    DefensiveMatchup(opponentAbbreviation: opponent, rankAgainstPosition: $0)
                }
            ),
            providerProjectedPoints: projection
        )
    }

    /// Builds an analyzed player directly, bypassing the projection engine, so
    /// optimizer tests can specify an exact distribution.
    static func analyzed(
        id: String,
        position: Position = .wideReceiver,
        mean: Double,
        deviation: Double,
        name: String? = nil
    ) -> AnalyzedPlayer {
        let context = context(
            id: id,
            name: name ?? "Player \(id)",
            position: position,
            projection: mean,
            pointsPerGame: mean
        )
        return AnalyzedPlayer(
            context: context,
            projection: Projection(
                mean: mean,
                standardDeviation: deviation,
                floor: max(0, mean - 1.15 * deviation),
                ceiling: mean + 1.45 * deviation,
                source: .measured,
                confidence: 0.7
            ),
            factors: [],
            opportunityScore: 0.6,
            trend: .steady
        )
    }

    static func league(
        teamCount: Int = 12,
        scoring: ScoringSettings = .ppr,
        slots: [RosterSlot: Int] = League.standardStartingSlots,
        bench: Int = 6,
        waivers: WaiverSystem = .faab(budget: 100),
        continuity: LeagueContinuity = .redraft,
        week: Int = 7
    ) -> League {
        League(
            id: "test-league",
            platform: .demo,
            name: "Test League",
            season: 2025,
            teamCount: teamCount,
            scoring: scoring,
            startingSlots: slots,
            benchSlots: bench,
            waivers: waivers,
            continuity: continuity
        )
    }

    static func team(
        id: String = "team-1",
        name: String = "Test Team",
        entries: [(PlayerContext, RosterSlot)],
        faab: Int? = 60
    ) -> FantasyTeam {
        FantasyTeam(
            id: id,
            name: name,
            wins: 3,
            losses: 3,
            roster: entries.map { RosterEntry(context: $0.0, slot: $0.1) },
            faabRemaining: faab
        )
    }

    static func index(_ players: [AnalyzedPlayer]) -> [PlayerID: AnalyzedPlayer] {
        Dictionary(players.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    }
}
