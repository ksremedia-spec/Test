import XCTest
@testable import Gameplan

final class ESPNMappingTests: XCTestCase {

    func testPositionMapping() {
        XCTAssertEqual(ESPNMapping.position(fromDefaultPositionID: 1), .quarterback)
        XCTAssertEqual(ESPNMapping.position(fromDefaultPositionID: 2), .runningBack)
        XCTAssertEqual(ESPNMapping.position(fromDefaultPositionID: 3), .wideReceiver)
        XCTAssertEqual(ESPNMapping.position(fromDefaultPositionID: 4), .tightEnd)
        XCTAssertEqual(ESPNMapping.position(fromDefaultPositionID: 5), .kicker)
        XCTAssertEqual(ESPNMapping.position(fromDefaultPositionID: 16), .defense)
        XCTAssertNil(ESPNMapping.position(fromDefaultPositionID: 99))
        // Falls back to eligible slots when the default position is missing.
        XCTAssertEqual(ESPNMapping.position(fromEligibleSlots: [4, 5, 23, 20]), .wideReceiver)
    }

    func testLineupSlotMapping() {
        XCTAssertEqual(ESPNMapping.slot(fromLineupSlotID: 0), .quarterback)
        XCTAssertEqual(ESPNMapping.slot(fromLineupSlotID: 23), .flex)
        XCTAssertEqual(ESPNMapping.slot(fromLineupSlotID: 20), .bench)
        XCTAssertEqual(ESPNMapping.slot(fromLineupSlotID: 21), .injuredReserve)
        XCTAssertNil(ESPNMapping.slot(fromLineupSlotID: 99))
    }

    func testProTeamMappingIncludesTheAwkwardIDs() {
        XCTAssertEqual(ESPNMapping.teamAbbreviation(fromProTeamID: 33), "BAL")
        XCTAssertEqual(ESPNMapping.teamAbbreviation(fromProTeamID: 34), "HOU")
        XCTAssertEqual(ESPNMapping.teamAbbreviation(fromProTeamID: 0), "FA")
        XCTAssertEqual(ESPNMapping.teamAbbreviation(fromProTeamID: nil), "FA")
    }

    func testInjuryStatusMapping() {
        XCTAssertEqual(ESPNMapping.injuryStatus(from: "QUESTIONABLE"), .questionable)
        XCTAssertEqual(ESPNMapping.injuryStatus(from: "injury_reserve"), .injuredReserve)
        XCTAssertEqual(ESPNMapping.injuryStatus(from: nil), .active)
        XCTAssertEqual(ESPNMapping.injuryStatus(from: "SOMETHING_NEW"), .active)
    }

    func testScoringSettingsAreDerivedFromPointsPerYard() {
        // ESPN publishes 0.04 points per passing yard, which is 25 yards per point.
        let dto = ESPNDTO.ScoringSettingsDTO(
            scoringItems: [
                ESPNDTO.ScoringItem(statId: 3, points: 0.04, pointsOverrides: nil),
                ESPNDTO.ScoringItem(statId: 4, points: 4, pointsOverrides: nil),
                ESPNDTO.ScoringItem(statId: 42, points: 0.1, pointsOverrides: nil),
                ESPNDTO.ScoringItem(statId: 53, points: 0.5, pointsOverrides: ["6": 1.0])
            ],
            scoringType: nil
        )

        let settings = ESPNMapping.scoringSettings(from: dto)

        XCTAssertEqual(settings.passingYardsPerPoint, 25, accuracy: 0.001)
        XCTAssertEqual(settings.passingTouchdown, 4)
        XCTAssertEqual(settings.receivingYardsPerPoint, 10, accuracy: 0.001)
        XCTAssertEqual(settings.pointsPerReception, 0.5)
        XCTAssertEqual(settings.tightEndReceptionBonus, 0.5, accuracy: 0.001)
        XCTAssertTrue(settings.isTightEndPremium)
        XCTAssertEqual(settings.formatName, "Half PPR · TE Premium")
    }

    func testMissingScoringItemsFallBackRatherThanScoringZero() {
        let settings = ESPNMapping.scoringSettings(from: ESPNDTO.ScoringSettingsDTO(scoringItems: [], scoringType: 1))
        XCTAssertEqual(settings.pointsPerReception, 1)
        XCTAssertGreaterThan(settings.passingYardsPerPoint, 0)
    }

    func testRosterSlotCountsBecomeALineup() {
        let dto = ESPNDTO.RosterSettingsDTO(lineupSlotCounts: [
            "0": 1, "2": 2, "4": 2, "6": 1, "23": 1, "16": 1, "17": 1, "20": 7, "21": 1, "24": 0
        ])

        let result = ESPNMapping.startingSlots(from: dto)

        XCTAssertEqual(result.starting[.quarterback], 1)
        XCTAssertEqual(result.starting[.runningBack], 2)
        XCTAssertEqual(result.starting[.wideReceiver], 2)
        XCTAssertEqual(result.starting[.flex], 1)
        XCTAssertEqual(result.bench, 7)
        XCTAssertEqual(result.ir, 1)
        XCTAssertNil(result.starting[.bench])
    }

    func testEmptyRosterSettingsFallBackToAStandardLineup() {
        let result = ESPNMapping.startingSlots(from: nil)
        XCTAssertEqual(result.starting, League.standardStartingSlots)
        XCTAssertGreaterThan(result.bench, 0)
    }

    func testEndpointBuildsTheExpectedURL() throws {
        let url = try ESPNEndpoint(
            season: 2025,
            leagueID: "12345",
            views: [.settings, .roster],
            scoringPeriod: 7
        ).url()

        let string = url.absoluteString
        XCTAssertTrue(string.contains("/seasons/2025/segments/0/leagues/12345"))
        XCTAssertTrue(string.contains("view=mSettings"))
        XCTAssertTrue(string.contains("view=mRoster"))
        XCTAssertTrue(string.contains("scoringPeriodId=7"))
    }
}

final class DemoProviderTests: XCTestCase {

    func testDemoIsLabelledAsDemo() {
        XCTAssertTrue(DemoFantasyProvider().isDemo)
    }

    func testDemoIsDeterministic() async throws {
        let fixedDate = Date(timeIntervalSince1970: 1_760_000_000)
        let first = try await DemoFantasyProvider(now: fixedDate)
            .matchup(leagueID: DemoLeague.leagueID, season: 2025, week: 7, teamID: DemoLeague.userTeamID)
        let second = try await DemoFantasyProvider(now: fixedDate)
            .matchup(leagueID: DemoLeague.leagueID, season: 2025, week: 7, teamID: DemoLeague.userTeamID)

        XCTAssertEqual(
            first.userTeam.roster.map { $0.context.gameLog.map(\.fantasyPoints) },
            second.userTeam.roster.map { $0.context.gameLog.map(\.fantasyPoints) }
        )
    }

    func testRosterFillsEveryStartingSlot() async throws {
        let provider = DemoFantasyProvider()
        let league = try await provider.league(id: DemoLeague.leagueID, season: DemoLeague.season())
        let matchup = try await provider.matchup(
            leagueID: DemoLeague.leagueID, season: league.season,
            week: DemoLeague.currentWeek(), teamID: DemoLeague.userTeamID
        )

        for (slot, count) in league.startingSlots {
            let filled = matchup.userTeam.roster.filter { $0.slot == slot }.count
            XCTAssertEqual(filled, count, "Demo roster doesn't fill \(slot.rawValue)")
        }
        XCTAssertEqual(matchup.userTeam.roster.count, league.rosterSize)
    }

    func testUnknownLeagueThrows() async {
        do {
            _ = try await DemoFantasyProvider().league(id: "nope", season: 2025)
            XCTFail("Expected a leagueNotFound error")
        } catch let error as FantasyDataError {
            XCTAssertEqual(error, .leagueNotFound("nope"))
        } catch {
            XCTFail("Unexpected error type")
        }
    }

    func testPlayersOnByeAreNotProjected() async throws {
        let provider = DemoFantasyProvider()
        let league = try await provider.league(id: DemoLeague.leagueID, season: DemoLeague.season())
        // Week 5 is a bye for several demo players.
        let matchup = try await provider.matchup(
            leagueID: DemoLeague.leagueID, season: league.season, week: 5, teamID: DemoLeague.userTeamID
        )
        let engine = PlayerProjectionEngine(league: league, week: 5)

        for entry in matchup.userTeam.roster where entry.player.byeWeek == 5 {
            XCTAssertEqual(engine.analyze(entry.context).projection.mean, 0)
        }
    }
}

final class FingerprintTests: XCTestCase {

    private func makeMatchup() -> (League, Matchup) {
        let league = Fixtures.league()
        let team = Fixtures.team(entries: [
            (Fixtures.context(id: "a", position: .quarterback), .quarterback),
            (Fixtures.context(id: "b", position: .runningBack), .runningBack)
        ])
        let opponent = Fixtures.team(id: "team-2", name: "Rivals", entries: [
            (Fixtures.context(id: "c", position: .quarterback), .quarterback)
        ])
        return (league, Matchup(id: "m", week: 7, userTeam: team, opponentTeam: opponent))
    }

    func testIdenticalInputProducesTheSameFingerprint() {
        let (league, matchup) = makeMatchup()
        let first = Fingerprint.forAnalysis(league: league, matchup: matchup, waiverPool: [])
        let second = Fingerprint.forAnalysis(league: league, matchup: matchup, waiverPool: [])
        XCTAssertEqual(first, second)
        XCTAssertFalse(first.isEmpty)
    }

    func testInjuryChangeInvalidatesTheFingerprint() {
        let (league, matchup) = makeMatchup()
        let before = Fingerprint.forAnalysis(league: league, matchup: matchup, waiverPool: [])

        var changed = matchup
        changed.userTeam.roster[0].context.player.injury = InjuryReport(status: .questionable)

        XCTAssertNotEqual(before, Fingerprint.forAnalysis(league: league, matchup: changed, waiverPool: []))
    }

    func testWeekChangeInvalidatesTheFingerprint() {
        let (league, matchup) = makeMatchup()
        let before = Fingerprint.forAnalysis(league: league, matchup: matchup, waiverPool: [])
        var changed = matchup
        changed.week = 8
        XCTAssertNotEqual(before, Fingerprint.forAnalysis(league: league, matchup: changed, waiverPool: []))
    }

    func testRosterOrderDoesNotChangeTheFingerprint() {
        let (league, matchup) = makeMatchup()
        let before = Fingerprint.forAnalysis(league: league, matchup: matchup, waiverPool: [])
        var reordered = matchup
        reordered.userTeam.roster.reverse()
        XCTAssertEqual(before, Fingerprint.forAnalysis(league: league, matchup: reordered, waiverPool: []))
    }
}

final class CacheTests: XCTestCase {

    private struct Sample: Codable, Equatable {
        var value: Int
    }

    func testStoresAndReadsBack() async {
        let cache = FileCache(namespace: "tests-\(UUID().uuidString)")
        await cache.store(Sample(value: 42), forKey: "sample", lifetime: 60)

        let read = await cache.value(forKey: "sample", as: Sample.self)

        XCTAssertEqual(read, Sample(value: 42))
        await cache.removeAll()
    }

    func testExpiredEntriesAreNotReturned() async {
        let cache = FileCache(namespace: "tests-\(UUID().uuidString)")
        await cache.store(Sample(value: 42), forKey: "sample", lifetime: -1)

        let read = await cache.value(forKey: "sample", as: Sample.self)

        XCTAssertNil(read)
        await cache.removeAll()
    }

    func testKeysWithUnsafeCharactersRoundTrip() async {
        let cache = FileCache(namespace: "tests-\(UUID().uuidString)")
        let key = "plan/espn:12345 week=7"
        await cache.store(Sample(value: 7), forKey: key, lifetime: 60)

        XCTAssertEqual(await cache.value(forKey: key, as: Sample.self), Sample(value: 7))
        await cache.removeAll()
    }

    func testRemoveAllClearsEverything() async {
        let cache = FileCache(namespace: "tests-\(UUID().uuidString)")
        await cache.store(Sample(value: 1), forKey: "a", lifetime: 60)
        await cache.removeAll()
        XCTAssertNil(await cache.value(forKey: "a", as: Sample.self))
    }

    func testNullCacheNeverReturnsAnything() async {
        let cache = NullCache()
        await cache.store(Sample(value: 1), forKey: "a", lifetime: 60)
        XCTAssertNil(await cache.value(forKey: "a", as: Sample.self))
    }
}

final class SeasonCalendarTests: XCTestCase {

    func testSeasonRollsOverInFebruary() {
        var components = DateComponents()
        components.year = 2026
        components.month = 1
        components.day = 15
        let january = Calendar(identifier: .gregorian).date(from: components)!
        XCTAssertEqual(SeasonCalendar(now: january).season, 2025)

        components.month = 9
        let september = Calendar(identifier: .gregorian).date(from: components)!
        XCTAssertEqual(SeasonCalendar(now: september).season, 2026)
    }

    func testWeekOneKickoffIsTheThursdayAfterLaborDay() throws {
        let calendar = SeasonCalendar()
        // Labor Day 2025 fell on 1 September, so kickoff was Thursday 4 September.
        let kickoff = try XCTUnwrap(calendar.week1Kickoff(season: 2025))
        let components = Calendar.autoupdatingCurrent.dateComponents([.month, .day, .weekday], from: kickoff)
        XCTAssertEqual(components.month, 9)
        XCTAssertEqual(components.day, 4)
        XCTAssertEqual(components.weekday, 5) // Thursday
    }

    func testEstimatedWeekIsClampedToTheSeason() {
        let calendar = SeasonCalendar()
        let kickoff = calendar.week1Kickoff(season: 2025)!

        let beforeSeason = SeasonCalendar(now: kickoff.addingTimeInterval(-30 * 24 * 3600))
        XCTAssertEqual(beforeSeason.estimatedWeek(season: 2025), 1)

        let midSeason = SeasonCalendar(now: kickoff.addingTimeInterval(45 * 24 * 3600))
        XCTAssertEqual(midSeason.estimatedWeek(season: 2025), 7)

        let farFuture = SeasonCalendar(now: kickoff.addingTimeInterval(365 * 24 * 3600))
        XCTAssertEqual(farFuture.estimatedWeek(season: 2025), 18)
    }

    func testSundayKickoffIsInTheFuture() throws {
        let calendar = SeasonCalendar()
        let sunday = try XCTUnwrap(calendar.sundayKickoff())
        XCTAssertGreaterThan(sunday, calendar.now)
    }

    func testWaiverProcessingRespectsTheConfiguredDay() throws {
        let calendar = SeasonCalendar()
        let wednesday = try XCTUnwrap(calendar.nextWaiverProcessing(weekday: 4))
        var eastern = Calendar(identifier: .gregorian)
        eastern.timeZone = TimeZone(identifier: "America/New_York")!
        XCTAssertEqual(eastern.component(.weekday, from: wednesday), 4)
        XCTAssertNil(calendar.nextWaiverProcessing(weekday: nil))
    }
}
