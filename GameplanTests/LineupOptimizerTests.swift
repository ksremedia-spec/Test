import XCTest
@testable import Gameplan

/// The behaviour that defines the product: the right lineup depends on whether
/// you're ahead or behind, not only on projected points.
final class LineupOptimizerTests: XCTestCase {

    /// A one-receiver league so the choice under test is isolated.
    private func singleSlotLeague() -> League {
        Fixtures.league(slots: [.wideReceiver: 1])
    }

    private func safeAndRiskyCandidates() -> [AnalyzedPlayer] {
        [
            Fixtures.analyzed(id: "safe", mean: 12, deviation: 3, name: "Safe Option"),
            Fixtures.analyzed(id: "risky", mean: 12, deviation: 9, name: "Risky Option")
        ]
    }

    func testFavoritePrefersTheSaferPlayerAtEqualProjection() {
        let candidates = safeAndRiskyCandidates()
        let players = Fixtures.index(candidates)
        // Opponent projects well below the user, so the user is a clear favorite.
        let optimizer = LineupOptimizer(league: singleSlotLeague(), opponent: (mean: 6, deviation: 4))

        let lineup = optimizer.optimize(candidates: candidates, players: players)

        XCTAssertEqual(lineup.assignments.first?.playerID?.value, "safe")
    }

    func testUnderdogPrefersTheRiskierPlayerAtEqualProjection() {
        let candidates = safeAndRiskyCandidates()
        let players = Fixtures.index(candidates)
        // Opponent projects well above the user, so upside is the only path.
        let optimizer = LineupOptimizer(league: singleSlotLeague(), opponent: (mean: 22, deviation: 4))

        let lineup = optimizer.optimize(candidates: candidates, players: players)

        XCTAssertEqual(lineup.assignments.first?.playerID?.value, "risky")
    }

    func testWithNoOpponentTheObjectiveIsExpectedPoints() {
        let candidates = [
            Fixtures.analyzed(id: "low", mean: 12, deviation: 9),
            Fixtures.analyzed(id: "high", mean: 14, deviation: 2)
        ]
        let optimizer = LineupOptimizer(league: singleSlotLeague(), opponent: nil)

        let lineup = optimizer.optimize(candidates: candidates, players: Fixtures.index(candidates))

        XCTAssertEqual(lineup.assignments.first?.playerID?.value, "high")
    }

    func testOptimizerRespectsSlotEligibility() {
        let league = Fixtures.league(slots: [.quarterback: 1, .runningBack: 1, .flex: 1])
        let candidates = [
            Fixtures.analyzed(id: "qb", position: .quarterback, mean: 24, deviation: 6),
            Fixtures.analyzed(id: "rb1", position: .runningBack, mean: 18, deviation: 7),
            Fixtures.analyzed(id: "wr1", position: .wideReceiver, mean: 16, deviation: 6),
            Fixtures.analyzed(id: "rb2", position: .runningBack, mean: 5, deviation: 3)
        ]
        let players = Fixtures.index(candidates)
        let optimizer = LineupOptimizer(league: league, opponent: (mean: 55, deviation: 12))

        let lineup = optimizer.optimize(candidates: candidates, players: players)

        for assignment in lineup.assignments {
            guard let id = assignment.playerID, let player = players[id] else { continue }
            XCTAssertTrue(
                assignment.slot.accepts(player.position),
                "\(player.position.abbreviation) is not eligible for \(assignment.slot.rawValue)"
            )
        }
        // The quarterback cannot fill flex in this configuration, so the flex must
        // go to the best remaining flex-eligible player.
        let flex = lineup.assignments.first { $0.slot == .flex }?.playerID?.value
        XCTAssertEqual(flex, "wr1")
        XCTAssertEqual(lineup.assignments.first { $0.slot == .quarterback }?.playerID?.value, "qb")
    }

    func testOptimalLineupIsNeverWorseThanTheCurrentOne() {
        let league = Fixtures.league()
        let contexts: [(PlayerContext, RosterSlot)] = [
            (Fixtures.context(id: "qb", position: .quarterback, projection: 20), .quarterback),
            (Fixtures.context(id: "rb1", position: .runningBack, projection: 15), .runningBack),
            (Fixtures.context(id: "rb2", position: .runningBack, projection: 11), .runningBack),
            // A weak receiver is starting while a strong one sits.
            (Fixtures.context(id: "wr_weak", position: .wideReceiver, projection: 5), .wideReceiver),
            (Fixtures.context(id: "wr2", position: .wideReceiver, projection: 13), .wideReceiver),
            (Fixtures.context(id: "te", position: .tightEnd, projection: 9), .tightEnd),
            (Fixtures.context(id: "flex", position: .wideReceiver, projection: 10), .flex),
            (Fixtures.context(id: "dst", position: .defense, projection: 8), .defense),
            (Fixtures.context(id: "k", position: .kicker, projection: 8), .kicker),
            (Fixtures.context(id: "wr_strong", position: .wideReceiver, projection: 17), .bench)
        ]
        let team = Fixtures.team(entries: contexts)
        let engine = PlayerProjectionEngine(league: league, week: 7)
        let players = Fixtures.index(team.roster.map { engine.analyze($0.context) })
        let optimizer = LineupOptimizer(league: league, opponent: (mean: 105, deviation: 22))

        let current = optimizer.currentLineup(for: team, players: players)
        let optimal = optimizer.optimize(
            candidates: team.availableForLineup.compactMap { players[$0.id] },
            players: players
        )

        XCTAssertGreaterThanOrEqual(optimizer.score(optimal), optimizer.score(current))
        XCTAssertTrue(
            optimal.startingPlayerIDs.contains(PlayerID(source: "test", value: "wr_strong")),
            "The optimizer should promote the strong bench receiver"
        )
        XCTAssertFalse(
            optimal.startingPlayerIDs.contains(PlayerID(source: "test", value: "wr_weak")),
            "The optimizer should bench the weak receiver"
        )
    }

    func testCurrentLineupFillsEveryConfiguredSlot() {
        let league = Fixtures.league()
        let team = Fixtures.team(entries: [
            (Fixtures.context(id: "qb", position: .quarterback), .quarterback),
            (Fixtures.context(id: "rb1", position: .runningBack), .runningBack)
        ])
        let engine = PlayerProjectionEngine(league: league, week: 7)
        let players = Fixtures.index(team.roster.map { engine.analyze($0.context) })
        let optimizer = LineupOptimizer(league: league, opponent: nil)

        let lineup = optimizer.currentLineup(for: team, players: players)

        XCTAssertEqual(lineup.assignments.count, league.startingLineupSize)
        // Unfilled slots stay present and empty rather than disappearing, so the
        // UI can tell the user they are scoring zero there.
        XCTAssertTrue(lineup.assignments.contains { $0.playerID == nil })
    }
}
