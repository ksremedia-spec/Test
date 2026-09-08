import XCTest
@testable import Gameplan

final class StartSitAnalyzerTests: XCTestCase {

    private let week = 7

    /// A roster with two running back slots and a clearly wrong receiver in the
    /// lineup, which is the shape that exposed the original pairing bug: walking
    /// the optimal lineup slot by slot kept resolving to the first slot of a
    /// repeated kind.
    private func setup() -> (
        analyzer: StartSitAnalyzer,
        current: Lineup,
        optimal: Lineup,
        players: [PlayerID: AnalyzedPlayer],
        optimizer: LineupOptimizer
    ) {
        let league = Fixtures.league()
        let entries: [(PlayerContext, RosterSlot)] = [
            (Fixtures.context(id: "qb", position: .quarterback, projection: 22), .quarterback),
            (Fixtures.context(id: "rb_good", position: .runningBack, projection: 19), .runningBack),
            (Fixtures.context(id: "rb_ok", position: .runningBack, projection: 13), .runningBack),
            (Fixtures.context(id: "wr_star", position: .wideReceiver, projection: 17), .wideReceiver),
            (Fixtures.context(id: "wr_bad", position: .wideReceiver, projection: 4), .wideReceiver),
            (Fixtures.context(id: "te", position: .tightEnd, projection: 10), .tightEnd),
            (Fixtures.context(id: "flex_bad", position: .wideReceiver, projection: 5), .flex),
            (Fixtures.context(id: "dst", position: .defense, projection: 8), .defense),
            (Fixtures.context(id: "k", position: .kicker, projection: 8), .kicker),
            (Fixtures.context(id: "wr_bench", position: .wideReceiver, projection: 15), .bench),
            (Fixtures.context(id: "rb_bench", position: .runningBack, projection: 11), .bench)
        ]
        let team = Fixtures.team(entries: entries)
        let engine = PlayerProjectionEngine(league: league, week: week)
        let players = Fixtures.index(team.roster.map { engine.analyze($0.context) })

        let optimizer = LineupOptimizer(league: league, opponent: (mean: 118, deviation: 24))
        let current = optimizer.currentLineup(for: team, players: players)
        let optimal = optimizer.optimize(
            candidates: team.availableForLineup.compactMap { players[$0.id] },
            players: players
        )
        let analyzer = StartSitAnalyzer(
            league: league,
            week: week,
            optimizer: optimizer,
            posture: .tossUp,
            deadline: nil
        )
        return (analyzer, current, optimal, players, optimizer)
    }

    func testNeverRecommendsBenchingSomeoneItAlsoRecommendsStarting() {
        let setup = setup()
        let moves = setup.analyzer.recommendations(
            current: setup.current,
            optimal: setup.optimal,
            players: setup.players
        )

        XCTAssertFalse(moves.isEmpty)
        for move in moves {
            guard case .swap(let promote, let demote, _) = move.action else { continue }
            XCTAssertTrue(setup.optimal.startingPlayerIDs.contains(promote))
            XCTAssertFalse(
                setup.optimal.startingPlayerIDs.contains(demote),
                "Recommended benching \(demote), who the optimizer starts"
            )
        }
    }

    func testTheStrongBenchReceiverDisplacesTheWeakStarterNotTheStar() {
        let setup = setup()
        let moves = setup.analyzer.recommendations(
            current: setup.current,
            optimal: setup.optimal,
            players: setup.players
        )

        let swap = moves.compactMap { move -> (PlayerID, PlayerID)? in
            guard case .swap(let promote, let demote, _) = move.action else { return nil }
            return promote.value == "wr_bench" ? (promote, demote) : nil
        }.first

        guard let swap else { return XCTFail("Expected the bench receiver to be promoted") }
        XCTAssertNotEqual(swap.1.value, "wr_star", "Displaced the wrong receiver")
        XCTAssertTrue(["wr_bad", "flex_bad"].contains(swap.1.value))
    }

    func testEachSwapReportsAPositiveWinProbabilityGain() {
        let setup = setup()
        let moves = setup.analyzer.recommendations(
            current: setup.current,
            optimal: setup.optimal,
            players: setup.players
        )

        for move in moves where move.category == .lineup && move.action.playerIDs.count == 2 {
            guard let delta = move.winProbabilityDelta else { continue }
            XCTAssertGreaterThan(delta, 0)
            XCTAssertLessThan(delta, 1)
        }
    }

    func testGainsAreMeasuredCumulativelyNotDoubleCounted() {
        let setup = setup()
        let moves = setup.analyzer.recommendations(
            current: setup.current,
            optimal: setup.optimal,
            players: setup.players
        )
        let claimed = moves.compactMap(\.winProbabilityDelta).reduce(0, +)
        let actual = setup.optimizer.score(setup.optimal) - setup.optimizer.score(setup.current)

        // The reported gains should add up to the real gain, not exceed it.
        XCTAssertEqual(claimed, actual, accuracy: 0.01)
    }

    func testEmptySlotIsReportedAsAMustDo() {
        let league = Fixtures.league()
        // A roster with no kicker at all.
        let team = Fixtures.team(entries: [
            (Fixtures.context(id: "qb", position: .quarterback, projection: 22), .quarterback)
        ])
        let engine = PlayerProjectionEngine(league: league, week: week)
        let players = Fixtures.index(team.roster.map { engine.analyze($0.context) })
        let optimizer = LineupOptimizer(league: league, opponent: (mean: 100, deviation: 22))
        let current = optimizer.currentLineup(for: team, players: players)
        let optimal = optimizer.optimize(
            candidates: team.availableForLineup.compactMap { players[$0.id] },
            players: players
        )
        let analyzer = StartSitAnalyzer(
            league: league, week: week, optimizer: optimizer, posture: .underdog, deadline: nil
        )

        let moves = analyzer.recommendations(current: current, optimal: optimal, players: players)

        XCTAssertTrue(moves.contains { $0.priority == .mustDo && $0.title.contains("empty") })
    }

    func testConfirmationIsProducedWhenTheLineupIsAlreadyRight() {
        let setup = setup()
        let analyzer = setup.analyzer
        let confirmation = analyzer.confirmationRecommendation(
            current: setup.optimal,
            players: setup.players
        )

        XCTAssertEqual(confirmation.priority, .noAction)
        XCTAssertFalse(confirmation.factors.isEmpty)
        XCTAssertEqual(confirmation.winProbabilityDelta, 0)
    }
}

final class WatchlistBuilderTests: XCTestCase {

    private let week = 7

    func testQuestionableStarterBecomesAWatchItemWithAContingency() {
        let league = Fixtures.league()
        let entries: [(PlayerContext, RosterSlot)] = [
            (Fixtures.context(
                id: "rb_hurt", position: .runningBack, projection: 15,
                injury: InjuryReport(status: .questionable, practice: .limited)
            ), .runningBack),
            (Fixtures.context(id: "rb2", position: .runningBack, projection: 12), .runningBack),
            (Fixtures.context(id: "rb_backup", name: "Backup Runner", position: .runningBack, projection: 9), .bench)
        ]
        let team = Fixtures.team(entries: entries)
        let engine = PlayerProjectionEngine(league: league, week: week)
        let players = Fixtures.index(team.roster.map { engine.analyze($0.context) })
        let optimizer = LineupOptimizer(league: league, opponent: nil)
        let lineup = optimizer.currentLineup(for: team, players: players)
        let bench = team.availableForLineup
            .compactMap { players[$0.id] }
            .filter { !lineup.startingPlayerIDs.contains($0.id) }

        let items = WatchlistBuilder(league: league, week: week)
            .build(lineup: lineup, players: players, bench: bench)

        let injury = items.first { $0.kind == .injury }
        XCTAssertNotNil(injury)
        XCTAssertEqual(injury?.playerID.map(\.value), "rb_hurt")
        // A watch item that doesn't say what to do about it isn't actionable.
        XCTAssertNotNil(injury?.contingency)
        XCTAssertTrue(
            injury?.contingency?.contains("Backup Runner") == true,
            "The contingency should name the replacement: \(injury?.contingency ?? "nil")"
        )
    }

    func testNoiseFreeWhenNothingIsUncertain() {
        let league = Fixtures.league()
        let team = Fixtures.team(entries: [
            (Fixtures.context(id: "rb1", position: .runningBack, projection: 15), .runningBack),
            (Fixtures.context(id: "rb2", position: .runningBack, projection: 12), .runningBack)
        ])
        let engine = PlayerProjectionEngine(league: league, week: week)
        let players = Fixtures.index(team.roster.map { engine.analyze($0.context) })
        let optimizer = LineupOptimizer(league: league, opponent: nil)
        let lineup = optimizer.currentLineup(for: team, players: players)

        let items = WatchlistBuilder(league: league, week: week)
            .build(lineup: lineup, players: players, bench: [])

        XCTAssertTrue(items.isEmpty, "Healthy players in clear weather shouldn't generate watch items")
    }

    func testWatchListIsCappedAndDeduplicatedByPlayer() {
        let league = Fixtures.league()
        let windy = WeatherConditions(temperatureFahrenheit: 35, windMilesPerHour: 24, precipitationChance: 0.6)
        let entries: [(PlayerContext, RosterSlot)] = (0..<8).map { index in
            (Fixtures.context(
                id: "wr\(index)", position: .wideReceiver, projection: 12,
                injury: InjuryReport(status: .questionable, practice: .limited),
                weather: windy
            ), index < 2 ? RosterSlot.wideReceiver : .bench)
        }
        let team = Fixtures.team(entries: entries)
        let engine = PlayerProjectionEngine(league: league, week: week)
        let players = Fixtures.index(team.roster.map { engine.analyze($0.context) })
        let optimizer = LineupOptimizer(league: league, opponent: nil)
        let lineup = optimizer.currentLineup(for: team, players: players)

        let items = WatchlistBuilder(league: league, week: week)
            .build(lineup: lineup, players: players, bench: [])

        XCTAssertLessThanOrEqual(items.count, 5)
        let playerIDs = items.compactMap(\.playerID)
        XCTAssertEqual(Set(playerIDs).count, playerIDs.count, "One player shouldn't appear twice")
    }
}
