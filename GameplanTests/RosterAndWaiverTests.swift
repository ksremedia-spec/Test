import XCTest
@testable import Gameplan

final class RosterAnalyzerTests: XCTestCase {

    private func waiverPool(week: Int = 7) -> [AnalyzedPlayer] {
        let league = Fixtures.league()
        let engine = PlayerProjectionEngine(league: league, week: week)
        return [
            Fixtures.context(id: "fa_wr1", position: .wideReceiver, projection: 8),
            Fixtures.context(id: "fa_wr2", position: .wideReceiver, projection: 7),
            Fixtures.context(id: "fa_rb1", position: .runningBack, projection: 7),
            Fixtures.context(id: "fa_rb2", position: .runningBack, projection: 6),
            Fixtures.context(id: "fa_te1", position: .tightEnd, projection: 5),
            Fixtures.context(id: "fa_te2", position: .tightEnd, projection: 4),
            Fixtures.context(id: "fa_qb1", position: .quarterback, projection: 14),
            Fixtures.context(id: "fa_qb2", position: .quarterback, projection: 13),
            Fixtures.context(id: "fa_k1", position: .kicker, projection: 8),
            Fixtures.context(id: "fa_dst1", position: .defense, projection: 7)
        ].map { engine.analyze($0) }
    }

    func testReplacementLevelComesFromTheWaiverPool() {
        let analyzer = RosterAnalyzer(league: Fixtures.league())
        let levels = analyzer.replacementLevels(waiverPool: waiverPool())

        // Weighted 70/30 toward the best available: 8 * 0.7 + 7 * 0.3.
        XCTAssertEqual(levels[.wideReceiver] ?? 0, 7.7, accuracy: 0.15)
        XCTAssertEqual(levels[.quarterback] ?? 0, 13.7, accuracy: 0.15)
    }

    func testEmptyPoolFallsBackWithoutCrashing() {
        let analyzer = RosterAnalyzer(league: Fixtures.league())
        let levels = analyzer.replacementLevels(waiverPool: [])

        for position in Position.allCases {
            XCTAssertNotNil(levels[position])
            XCTAssertGreaterThan(levels[position] ?? 0, 0)
        }
    }

    func testWeakPositionIsIdentified() {
        let league = Fixtures.league()
        let week = 7
        let entries: [(PlayerContext, RosterSlot)] = [
            (Fixtures.context(id: "qb", position: .quarterback, projection: 24), .quarterback),
            (Fixtures.context(id: "rb1", position: .runningBack, projection: 20), .runningBack),
            (Fixtures.context(id: "rb2", position: .runningBack, projection: 17), .runningBack),
            // Both receivers are below what's freely available.
            (Fixtures.context(id: "wr1", position: .wideReceiver, projection: 6), .wideReceiver),
            (Fixtures.context(id: "wr2", position: .wideReceiver, projection: 5), .wideReceiver),
            (Fixtures.context(id: "te", position: .tightEnd, projection: 11), .tightEnd),
            (Fixtures.context(id: "flex", position: .runningBack, projection: 12), .flex),
            (Fixtures.context(id: "dst", position: .defense, projection: 9), .defense),
            (Fixtures.context(id: "k", position: .kicker, projection: 9), .kicker)
        ]
        let team = Fixtures.team(entries: entries)
        let engine = PlayerProjectionEngine(league: league, week: week)
        let players = Fixtures.index(team.roster.map { engine.analyze($0.context) })
        let analyzer = RosterAnalyzer(league: league)
        let levels = analyzer.replacementLevels(waiverPool: waiverPool())

        let assessments = analyzer.assess(team: team, players: players, replacementLevels: levels)
        let weakness = analyzer.biggestWeakness(from: assessments)

        XCTAssertEqual(weakness?.position, .wideReceiver)
        let runningBack = assessments.first { $0.position == .runningBack }
        XCTAssertTrue(runningBack?.isStrength ?? false)
    }

    func testMissingStarterIsTreatedAsAHole() {
        let league = Fixtures.league()
        let team = Fixtures.team(entries: [
            (Fixtures.context(id: "qb", position: .quarterback, projection: 22), .quarterback)
        ])
        let engine = PlayerProjectionEngine(league: league, week: 7)
        let players = Fixtures.index(team.roster.map { engine.analyze($0.context) })
        let analyzer = RosterAnalyzer(league: league)

        let assessments = analyzer.assess(
            team: team,
            players: players,
            replacementLevels: analyzer.replacementLevels(waiverPool: waiverPool())
        )

        let receivers = assessments.first { $0.position == .wideReceiver }
        XCTAssertEqual(receivers?.strengthScore, -1)
        XCTAssertTrue(receivers?.headline.contains("short") ?? false)
    }

    func testLeagueSizeChangesRequiredStarters() {
        let standard = RosterAnalyzer(league: Fixtures.league())
        XCTAssertEqual(standard.requiredStarters(at: .wideReceiver), 3) // 2 plus the flex
        XCTAssertEqual(standard.requiredStarters(at: .quarterback), 1)
        XCTAssertEqual(standard.requiredStarters(at: .tightEnd), 1)

        let superflex = RosterAnalyzer(league: Fixtures.league(slots: [
            .quarterback: 1, .runningBack: 2, .wideReceiver: 3, .tightEnd: 1, .superflex: 1
        ]))
        XCTAssertGreaterThanOrEqual(superflex.requiredStarters(at: .quarterback), 1)
    }

    func testLeagueWideStartersScalesWithTeamCount() {
        let small = Fixtures.league(teamCount: 8)
        let large = Fixtures.league(teamCount: 14)
        XCTAssertLessThan(
            small.leagueWideStarters(at: .wideReceiver),
            large.leagueWideStarters(at: .wideReceiver)
        )
    }
}

final class WaiverAnalyzerTests: XCTestCase {

    private let week = 7

    /// A roster that is strong at running back and thin at receiver.
    private func setup(
        league: League = Fixtures.league()
    ) -> (analyzer: WaiverAnalyzer, pool: [AnalyzedPlayer], roster: [AnalyzedPlayer], lineup: Lineup, optimizer: LineupOptimizer, players: [PlayerID: AnalyzedPlayer]) {
        let engine = PlayerProjectionEngine(league: league, week: week)

        let entries: [(PlayerContext, RosterSlot)] = [
            (Fixtures.context(id: "qb", position: .quarterback, projection: 25), .quarterback),
            (Fixtures.context(id: "rb1", position: .runningBack, projection: 21), .runningBack),
            (Fixtures.context(id: "rb2", position: .runningBack, projection: 18), .runningBack),
            (Fixtures.context(id: "wr1", position: .wideReceiver, projection: 13), .wideReceiver),
            (Fixtures.context(id: "wr2", position: .wideReceiver, projection: 4), .wideReceiver),
            (Fixtures.context(id: "te", position: .tightEnd, projection: 10), .tightEnd),
            (Fixtures.context(id: "flex", position: .runningBack, projection: 14), .flex),
            (Fixtures.context(id: "dst", position: .defense, projection: 8), .defense),
            (Fixtures.context(id: "k", position: .kicker, projection: 8), .kicker),
            (Fixtures.context(id: "benchrb", position: .runningBack, projection: 9), .bench),
            (Fixtures.context(id: "deadweight", position: .tightEnd, projection: 2), .bench)
        ]
        let team = Fixtures.team(entries: entries)
        let players = Fixtures.index(team.roster.map { engine.analyze($0.context) })
        let roster = team.availableForLineup.compactMap { players[$0.id] }

        let optimizer = LineupOptimizer(league: league, opponent: (mean: 120, deviation: 22))
        let lineup = optimizer.currentLineup(for: team, players: players)

        // A high-projection quarterback the user cannot start, and a modest
        // receiver who would immediately improve the lineup.
        let pool = [
            Fixtures.context(id: "fa_qb", position: .quarterback, projection: 22),
            Fixtures.context(id: "fa_wr", position: .wideReceiver, projection: 11, rosteredChange: 14),
            Fixtures.context(id: "fa_wr_low", position: .wideReceiver, projection: 5),
            Fixtures.context(id: "fa_te", position: .tightEnd, projection: 4),
            Fixtures.context(id: "fa_rb", position: .runningBack, projection: 6)
        ].map { engine.analyze($0) }

        let rosterAnalyzer = RosterAnalyzer(league: league)
        let levels = rosterAnalyzer.replacementLevels(waiverPool: pool)
        let assessments = rosterAnalyzer.assess(team: team, players: players, replacementLevels: levels)

        let analyzer = WaiverAnalyzer(
            league: league,
            week: week,
            replacementLevels: levels,
            assessments: assessments,
            faabRemaining: 60,
            deadline: nil
        )
        return (analyzer, pool, roster, lineup, optimizer, players)
    }

    func testTopPickupIsNotSimplyTheHighestProjectedPlayer() {
        let setup = setup()
        let ranked = setup.analyzer.rank(
            pool: setup.pool,
            roster: setup.roster,
            currentLineup: setup.lineup,
            optimizer: setup.optimizer,
            players: setup.players
        )

        XCTAssertFalse(ranked.isEmpty)
        // The free-agent quarterback projects highest in the pool but cannot crack
        // a lineup that already starts a better one.
        XCTAssertEqual(ranked.first?.id.value, "fa_wr")
        let quarterbackRank = ranked.firstIndex { $0.id.value == "fa_qb" }
        if let quarterbackRank {
            XCTAssertGreaterThan(quarterbackRank, 0)
        }
    }

    func testTopPickupImprovesTheLineupAndFillsTheWeakness() {
        let setup = setup()
        let ranked = setup.analyzer.rank(
            pool: setup.pool,
            roster: setup.roster,
            currentLineup: setup.lineup,
            optimizer: setup.optimizer,
            players: setup.players
        )

        guard let top = ranked.first else { return XCTFail("Expected a waiver recommendation") }
        XCTAssertGreaterThan(top.immediateUpgrade, 1)
        XCTAssertTrue(top.fitsWeakness)
    }

    func testSuggestedDropIsNeverAStarter() {
        let setup = setup()
        let ranked = setup.analyzer.rank(
            pool: setup.pool,
            roster: setup.roster,
            currentLineup: setup.lineup,
            optimizer: setup.optimizer,
            players: setup.players
        )

        let starting = setup.lineup.startingPlayerIDs
        for candidate in ranked {
            if let drop = candidate.suggestedDrop {
                XCTAssertFalse(
                    starting.contains(drop.id),
                    "Suggested dropping \(drop.player.fullName), who is in the starting lineup"
                )
            }
        }
    }

    func testFAABSuggestionStaysWithinTheRemainingBudget() {
        let setup = setup()
        let ranked = setup.analyzer.rank(
            pool: setup.pool,
            roster: setup.roster,
            currentLineup: setup.lineup,
            optimizer: setup.optimizer,
            players: setup.players
        )

        for candidate in ranked {
            guard let range = candidate.faabRange else { continue }
            XCTAssertGreaterThanOrEqual(range.lowerBound, 1)
            XCTAssertLessThanOrEqual(range.upperBound, 60)
            XCTAssertLessThanOrEqual(range.lowerBound, range.upperBound)
        }
    }

    func testNoFAABRangeInANonFAABLeague() {
        let setup = setup(league: Fixtures.league(waivers: .rollingPriority))
        let ranked = setup.analyzer.rank(
            pool: setup.pool,
            roster: setup.roster,
            currentLineup: setup.lineup,
            optimizer: setup.optimizer,
            players: setup.players
        )
        // The analyzer in `setup` is built from the league passed in, so a
        // priority-based league must not produce dollar figures.
        for candidate in ranked {
            XCTAssertNil(candidate.faabRange)
        }
    }

    func testRecommendationCarriesADropAndAReason() {
        let setup = setup()
        let ranked = setup.analyzer.rank(
            pool: setup.pool,
            roster: setup.roster,
            currentLineup: setup.lineup,
            optimizer: setup.optimizer,
            players: setup.players
        )
        guard let top = ranked.first else { return XCTFail("Expected a waiver recommendation") }

        let recommendation = setup.analyzer.recommendation(for: top, rank: 0)

        XCTAssertTrue(recommendation.title.contains("Priority pickup"))
        XCTAssertEqual(recommendation.category, .waiver)
        XCTAssertFalse(recommendation.factors.isEmpty)
        if case .add(_, let drop) = recommendation.action {
            XCTAssertNotNil(drop)
        } else {
            XCTFail("Expected an add action")
        }
    }
}
