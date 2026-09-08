import XCTest
@testable import Gameplan

/// The anti-hallucination boundary. If these pass, a model cannot slip a made-up
/// statistic into the user's game plan.
final class NarrationValidatorTests: XCTestCase {

    private func pack() -> EvidencePack {
        EvidencePack(
            week: 7,
            season: 2025,
            league: EvidencePack.LeagueFacts(
                name: "Test", teamCount: 12, scoringFormat: "Full PPR",
                startingLineup: ["QB", "RB"], waiverSystem: "FAAB ($100)",
                faabRemaining: 60, continuity: "Redraft", isPlayoffWeek: false
            ),
            matchup: EvidencePack.MatchupFacts(
                opponentName: "Rivals", userRecord: "4-2", opponentRecord: "5-1",
                winProbability: 0.61, posture: "favorite",
                projectedPoints: 118.4, projectedOpponentPoints: 111.2,
                projectedFloor: 92.0, projectedCeiling: 149.0,
                positionMargins: ["WR": -9.7]
            ),
            roster: [],
            opponentStarters: [],
            waiverCandidates: [],
            positionAssessments: [],
            proposedMoves: [],
            watchItems: [],
            dataGaps: []
        )
    }

    func testAcceptsProseBuiltFromTheEvidence() {
        let validator = NarrationValidator()
        let narration = Narration(
            headline: "You're favored this week.",
            positioning: "Gameplan projects 118.4 for you against 111.2, about a 61% chance to win. WR is down 9.7 points.",
            restingEasy: "Nothing else needs action right now."
        )

        XCTAssertTrue(validator.validate(narration, against: pack()).isAcceptable)
    }

    func testRejectsAnInventedStatistic() {
        let validator = NarrationValidator()
        let narration = Narration(
            headline: "You're favored this week.",
            // 27% target share appears nowhere in the evidence.
            positioning: "He's commanding a 27% target share, so start him.",
            restingEasy: "Nothing else needs action."
        )

        let result = validator.validate(narration, against: pack())

        XCTAssertFalse(result.isAcceptable)
        XCTAssertTrue(result.unsupportedValues.contains(27))
        XCTAssertNotNil(result.reason)
    }

    func testRejectsAnInventedFigureInAMoveSummaryToo() {
        let validator = NarrationValidator()
        let narration = Narration(
            headline: "One move to make.",
            positioning: "Your lineup is close.",
            moveSummaries: ["move-1": "He has averaged 19.3 points over his last three games."],
            restingEasy: "Nothing else."
        )

        XCTAssertFalse(validator.validate(narration, against: pack()).isAcceptable)
    }

    func testToleratesRoundingWithinTolerance() {
        let validator = NarrationValidator()
        let narration = Narration(
            headline: "You're favored.",
            // 118.4 rounded to 118.
            positioning: "Gameplan projects 118 for you.",
            restingEasy: "Nothing else."
        )

        XCTAssertTrue(validator.validate(narration, against: pack()).isAcceptable)
    }

    func testSmallCountingNumbersAreNotTreatedAsClaims() {
        let validator = NarrationValidator()
        let narration = Narration(
            headline: "You have 2 moves to make.",
            positioning: "There are 3 things worth watching.",
            restingEasy: "Nothing else needs action."
        )

        XCTAssertTrue(validator.validate(narration, against: pack()).isAcceptable)
    }

    func testRejectsAnEmptyHeadline() {
        let validator = NarrationValidator()
        let narration = Narration(headline: "   ", positioning: "Fine.", restingEasy: "Fine.")

        XCTAssertFalse(validator.validate(narration, against: pack()).isAcceptable)
    }

    func testNumberExtractionHandlesPunctuation() {
        let validator = NarrationValidator()
        let numbers = validator.numbers(in: "Projected 118.4, floor 92.0. Bid $12–$18 (61%).")
        XCTAssertEqual(numbers, [118.4, 92.0, 12, 18, 61])
    }
}

final class TemplateNarratorTests: XCTestCase {

    func testProducesNonEmptyProseForADemoWeek() async throws {
        let provider = DemoFantasyProvider()
        let league = try await provider.league(id: DemoLeague.leagueID, season: DemoLeague.season())
        let week = try await provider.currentWeek(leagueID: DemoLeague.leagueID, season: league.season)
        let matchup = try await provider.matchup(
            leagueID: DemoLeague.leagueID, season: league.season, week: week, teamID: DemoLeague.userTeamID
        )
        let pool = try await provider.freeAgents(
            leagueID: DemoLeague.leagueID, season: league.season, week: week, limit: 30
        )
        let analysis = await GamePlanBuilder(league: league, week: week)
            .build(matchup: matchup, waiverPool: pool)

        let narration = try await TemplateNarrator().narrate(analysis.evidence)

        XCTAssertFalse(narration.headline.isEmpty)
        XCTAssertFalse(narration.positioning.isEmpty)
        XCTAssertFalse(narration.restingEasy.isEmpty)
    }

    /// The built-in writer must itself survive the validator — otherwise the
    /// standard the remote narrator is held to would be one the app does not meet.
    func testTemplateNarrationPassesItsOwnValidator() async throws {
        let provider = DemoFantasyProvider()
        let league = try await provider.league(id: DemoLeague.leagueID, season: DemoLeague.season())
        let week = try await provider.currentWeek(leagueID: DemoLeague.leagueID, season: league.season)
        let matchup = try await provider.matchup(
            leagueID: DemoLeague.leagueID, season: league.season, week: week, teamID: DemoLeague.userTeamID
        )
        let pool = try await provider.freeAgents(
            leagueID: DemoLeague.leagueID, season: league.season, week: week, limit: 30
        )
        let analysis = await GamePlanBuilder(league: league, week: week)
            .build(matchup: matchup, waiverPool: pool)

        let narration = try await TemplateNarrator().narrate(analysis.evidence)
        let result = NarrationValidator().validate(narration, against: analysis.evidence)

        XCTAssertTrue(result.isAcceptable, result.reason ?? "")
    }
}
