import XCTest
@testable import Gameplan

/// End-to-end checks on the whole pipeline, run against the demo league so the
/// experience a new user sees is itself under test.
final class GamePlanBuilderTests: XCTestCase {

    private func buildAnalysis() async throws -> (WeeklyAnalysis, League, Matchup) {
        let provider = DemoFantasyProvider()
        let league = try await provider.league(id: DemoLeague.leagueID, season: DemoLeague.season())
        let week = try await provider.currentWeek(leagueID: DemoLeague.leagueID, season: league.season)
        let matchup = try await provider.matchup(
            leagueID: DemoLeague.leagueID,
            season: league.season,
            week: week,
            teamID: DemoLeague.userTeamID
        )
        let pool = try await provider.freeAgents(
            leagueID: DemoLeague.leagueID,
            season: league.season,
            week: week,
            limit: 40
        )
        let builder = GamePlanBuilder(league: league, week: week)
        let analysis = await builder.build(matchup: matchup, waiverPool: pool)
        return (analysis, league, matchup)
    }

    func testDemoLeagueProducesAUsablePlan() async throws {
        let (analysis, _, _) = try await buildAnalysis()
        let plan = analysis.plan

        XCTAssertFalse(plan.headline.isEmpty)
        XCTAssertFalse(plan.positioning.isEmpty)
        XCTAssertFalse(plan.restingEasy.isEmpty)
        XCTAssertFalse(plan.moves.isEmpty, "A plan with no moves at all tells the user nothing")
        XCTAssertFalse(plan.positionAssessments.isEmpty)
        XCTAssertGreaterThan(plan.outlook.winProbability, 0)
        XCTAssertLessThan(plan.outlook.winProbability, 1)
        XCTAssertGreaterThan(plan.outlook.projectedPoints, 50)
        XCTAssertGreaterThan(plan.outlook.projectedOpponentPoints, 50)
    }

    func testMovesAreRankedAndCapped() async throws {
        let (analysis, _, _) = try await buildAnalysis()
        let moves = analysis.plan.moves

        XCTAssertLessThanOrEqual(moves.count, 6, "An unbounded list of advice is the same as no advice")
        // Priorities must be non-decreasing down the list.
        for pair in zip(moves, moves.dropFirst()) {
            XCTAssertLessThanOrEqual(pair.0.priority.sortOrder, pair.1.priority.sortOrder)
        }
        XCTAssertEqual(Set(moves.map(\.id)).count, moves.count, "Duplicate recommendations")
    }

    func testEveryMoveIsExplainable() async throws {
        let (analysis, _, _) = try await buildAnalysis()

        for move in analysis.plan.moves {
            XCTAssertFalse(move.title.isEmpty, "Move \(move.id) has no title")
            XCTAssertFalse(move.summary.isEmpty, "Move \(move.id) has no summary")
            XCTAssertFalse(move.factors.isEmpty, "Move \(move.id) has no supporting evidence")
            XCTAssertTrue((0...1).contains(move.confidenceScore))
        }
    }

    func testLineupAdviceMatchesTheOptimizerResult() async throws {
        let (analysis, _, _) = try await buildAnalysis()

        // Anything the plan says to start must actually be in the optimal lineup.
        for move in analysis.plan.moves where move.category == .lineup {
            if case .swap(let promote, let demote, _) = move.action {
                XCTAssertTrue(
                    analysis.optimalLineup.startingPlayerIDs.contains(promote),
                    "Recommended starting a player the optimizer doesn't start"
                )
                XCTAssertFalse(
                    analysis.optimalLineup.startingPlayerIDs.contains(demote),
                    "Recommended benching a player the optimizer does start"
                )
            }
        }
    }

    func testDemoLeagueSurfacesTheReceiverWeakness() async throws {
        let (analysis, _, _) = try await buildAnalysis()
        // The demo roster is deliberately built strong at running back and thin at
        // receiver, so the engine should reach that conclusion on its own.
        XCTAssertEqual(analysis.plan.biggestWeakness?.position, .wideReceiver)
    }

    func testDataQualityIsReportedHonestly() async throws {
        let (analysis, _, _) = try await buildAnalysis()
        let quality = analysis.plan.dataQuality

        XCTAssertTrue(quality.hasProviderProjections)
        XCTAssertTrue(quality.hasUsageData)
        // The demo supplies no betting market, and the app must say so rather than
        // implying it had one.
        XCTAssertFalse(quality.hasBettingData)
        XCTAssertTrue(quality.notes.contains { $0.lowercased().contains("betting") })
    }

    func testEvidencePackContainsOnlyDataTheEngineProduced() async throws {
        let (analysis, league, _) = try await buildAnalysis()
        let pack = analysis.evidence

        XCTAssertEqual(pack.league.teamCount, league.teamCount)
        XCTAssertEqual(pack.week, analysis.plan.week)
        XCTAssertFalse(pack.roster.isEmpty)
        XCTAssertFalse(pack.opponentStarters.isEmpty)
        XCTAssertEqual(pack.proposedMoves.count, analysis.plan.moves.count)
        // The pack must be encodable, because that is how it reaches a model.
        XCTAssertNoThrow(try JSONEncoder().encode(pack))
    }

    func testPostureFollowsWinProbability() async throws {
        let (analysis, _, _) = try await buildAnalysis()
        let outlook = analysis.plan.outlook
        XCTAssertEqual(outlook.posture, WeeklyPosture.from(winProbability: outlook.winProbability))
    }

    func testNoOpponentFallsBackToMaximisingPoints() async throws {
        let provider = DemoFantasyProvider()
        let league = try await provider.league(id: DemoLeague.leagueID, season: DemoLeague.season())
        let week = try await provider.currentWeek(leagueID: DemoLeague.leagueID, season: league.season)
        var matchup = try await provider.matchup(
            leagueID: DemoLeague.leagueID, season: league.season, week: week, teamID: DemoLeague.userTeamID
        )
        matchup.opponentTeam = nil

        let analysis = await GamePlanBuilder(league: league, week: week)
            .build(matchup: matchup, waiverPool: [])

        XCTAssertEqual(analysis.plan.outlook.winProbability, 0.99, accuracy: 0.001)
        XCTAssertTrue(analysis.plan.dataQuality.notes.contains { $0.contains("No opponent") })
    }

    func testAnalysisIsDeterministicForIdenticalInput() async throws {
        let (first, _, _) = try await buildAnalysis()
        let (second, _, _) = try await buildAnalysis()

        XCTAssertEqual(first.plan.inputFingerprint, second.plan.inputFingerprint)
        XCTAssertEqual(first.plan.headline, second.plan.headline)
        XCTAssertEqual(first.plan.moves.map(\.id), second.plan.moves.map(\.id))
        XCTAssertEqual(
            first.plan.outlook.projectedPoints,
            second.plan.outlook.projectedPoints,
            accuracy: 0.0001
        )
    }
}
