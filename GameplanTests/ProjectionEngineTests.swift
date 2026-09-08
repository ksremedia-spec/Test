import XCTest
@testable import Gameplan

final class ProjectionEngineTests: XCTestCase {

    private let league = Fixtures.league()

    func testUsesProviderProjectionWhenAvailableAndLabelsItMeasured() {
        let engine = PlayerProjectionEngine(league: league, week: 7)
        let context = Fixtures.context(id: "a", projection: 14.5, pointsPerGame: 9)

        let analyzed = engine.analyze(context)

        XCTAssertEqual(analyzed.projection.mean, 14.5, accuracy: 0.01)
        XCTAssertEqual(analyzed.projection.source, .measured)
    }

    func testDerivesFromUsageWhenNoProjectionIsPublished() {
        let engine = PlayerProjectionEngine(league: league, week: 7)
        let context = Fixtures.context(id: "a", projection: nil, pointsPerGame: 11)

        let analyzed = engine.analyze(context)

        XCTAssertEqual(analyzed.projection.mean, 11, accuracy: 0.01)
        XCTAssertEqual(analyzed.projection.source, .derived)
        XCTAssertTrue(
            analyzed.factors.contains { $0.evidence == .derived },
            "A derived projection must be labelled as calculated, not measured"
        )
    }

    func testByePlayerProjectsZero() {
        let engine = PlayerProjectionEngine(league: league, week: 7)
        let context = Fixtures.context(id: "a", projection: 18, byeWeek: 7)

        let analyzed = engine.analyze(context)

        XCTAssertEqual(analyzed.projection.mean, 0)
        XCTAssertEqual(analyzed.projection.ceiling, 0)
        XCTAssertTrue(analyzed.factors.contains { $0.summary.lowercased().contains("bye") })
    }

    func testRuledOutPlayerProjectsZero() {
        let engine = PlayerProjectionEngine(league: league, week: 7)
        let context = Fixtures.context(
            id: "a",
            projection: 18,
            injury: InjuryReport(status: .out)
        )

        let analyzed = engine.analyze(context)

        XCTAssertEqual(analyzed.projection.mean, 0, accuracy: 0.001)
    }

    func testQuestionablePlayerLosesMeanAndGainsUncertainty() {
        let engine = PlayerProjectionEngine(league: league, week: 7)
        let healthy = engine.analyze(Fixtures.context(id: "a", projection: 16))
        let questionable = engine.analyze(Fixtures.context(
            id: "b",
            projection: 16,
            injury: InjuryReport(status: .questionable, practice: .limited)
        ))

        XCTAssertLessThan(questionable.projection.mean, healthy.projection.mean)
        XCTAssertGreaterThan(questionable.projection.standardDeviation, healthy.projection.standardDeviation)
        XCTAssertLessThan(questionable.projection.floor, healthy.projection.floor)
        XCTAssertLessThan(questionable.projection.confidence, healthy.projection.confidence)
    }

    func testFullPracticeBeatsNoPracticeForTheSameDesignation() {
        let engine = PlayerProjectionEngine(league: league, week: 7)
        let full = engine.analyze(Fixtures.context(
            id: "a", projection: 16,
            injury: InjuryReport(status: .questionable, practice: .full)
        ))
        let none = engine.analyze(Fixtures.context(
            id: "b", projection: 16,
            injury: InjuryReport(status: .questionable, practice: .didNotParticipate)
        ))

        XCTAssertGreaterThan(full.projection.mean, none.projection.mean)
    }

    func testFavorableMatchupRaisesTheProjection() {
        let engine = PlayerProjectionEngine(league: league, week: 7)
        let tough = engine.analyze(Fixtures.context(id: "a", projection: 12, matchupRank: 2))
        let easy = engine.analyze(Fixtures.context(id: "b", projection: 12, matchupRank: 31))

        XCTAssertGreaterThan(easy.projection.mean, tough.projection.mean)
        // The adjustment is deliberately capped: matchup is real but weaker than
        // volume, and overstating it is the classic fantasy-analysis error.
        XCTAssertLessThan(easy.projection.mean / tough.projection.mean, 1.15)
    }

    func testHighWindHurtsPassingGamePlayersAndHelpsRunningBacks() {
        let engine = PlayerProjectionEngine(league: league, week: 7)
        let windy = WeatherConditions(temperatureFahrenheit: 40, windMilesPerHour: 25, precipitationChance: 0.2)

        let receiverCalm = engine.analyze(Fixtures.context(id: "a", position: .wideReceiver, projection: 12))
        let receiverWindy = engine.analyze(Fixtures.context(id: "b", position: .wideReceiver, projection: 12, weather: windy))
        let backCalm = engine.analyze(Fixtures.context(id: "c", position: .runningBack, projection: 12))
        let backWindy = engine.analyze(Fixtures.context(id: "d", position: .runningBack, projection: 12, weather: windy))

        XCTAssertLessThan(receiverWindy.projection.mean, receiverCalm.projection.mean)
        XCTAssertGreaterThanOrEqual(backWindy.projection.mean, backCalm.projection.mean)
    }

    func testObservedVarianceIsPreferredOverThePositionalAssumption() {
        let engine = PlayerProjectionEngine(league: league, week: 7)
        let consistent = engine.analyze(Fixtures.context(
            id: "a", projection: 12, scores: [11.5, 12.2, 11.8, 12.4, 12.1, 11.9]
        ))
        let volatile = engine.analyze(Fixtures.context(
            id: "b", projection: 12, scores: [2.0, 26.0, 3.5, 24.0, 1.0, 27.0]
        ))

        XCTAssertLessThan(consistent.projection.standardDeviation, volatile.projection.standardDeviation)
        XCTAssertGreaterThan(volatile.projection.ceiling, consistent.projection.ceiling)
        XCTAssertLessThan(volatile.projection.floor, consistent.projection.floor)
    }

    func testTrendIsDetectedFromRecentGames() {
        let rising = Fixtures.context(id: "a", scores: [4, 5, 4, 14, 16, 15])
        let falling = Fixtures.context(id: "b", scores: [16, 15, 17, 5, 4, 5])

        XCTAssertEqual(rising.usageTrend, .rising)
        XCTAssertEqual(falling.usageTrend, .falling)
    }

    func testNoDataProducesZeroWithLowConfidence() {
        let engine = PlayerProjectionEngine(league: league, week: 7)
        let context = PlayerContext(
            player: Fixtures.player(id: "ghost"),
            recentUsage: .unknown,
            seasonUsage: .unknown,
            gameLog: [],
            environment: nil,
            providerProjectedPoints: nil
        )

        let analyzed = engine.analyze(context)

        XCTAssertEqual(analyzed.projection.mean, 0)
        XCTAssertLessThan(analyzed.projection.confidence, 0.6)
    }
}
