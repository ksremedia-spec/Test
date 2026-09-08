import XCTest
@testable import Gameplan

/// A fantasy provider whose players carry no opponent, no kickoff and no betting
/// line — which is the shape a real ESPN league arrives in.
private struct BareFantasyProvider: FantasyDataProvider {
    let identifier = "test"
    let isDemo = false
    var leagueValue: League
    var team: FantasyTeam
    var opponent: FantasyTeam?
    var freeAgentPool: [PlayerContext]

    func availableLeagues() async throws -> [LeagueSummary] { [] }
    func league(id: String, season: Int) async throws -> League { leagueValue }
    func currentWeek(leagueID: String, season: Int) async throws -> Int { 6 }
    func teams(leagueID: String, season: Int) async throws -> [TeamSummary] { [] }

    func matchup(leagueID: String, season: Int, week: Int, teamID: String) async throws -> Matchup {
        Matchup(id: "m", week: week, userTeam: team, opponentTeam: opponent)
    }

    func freeAgents(leagueID: String, season: Int, week: Int, limit: Int) async throws -> [PlayerContext] {
        freeAgentPool
    }
}

/// Supplies a fixed schedule, depth chart and injury report.
private struct StubContextProvider: NFLContextProvider {
    let identifier = "stub"
    var scheduled: [NFLGame]
    var ranks: [String: Int] = [:]
    var reports: [String: InjuryReport] = [:]

    func games(season: Int, week: Int) async -> [NFLGame] { scheduled }
    func depthChart(season: Int) async -> [String: Int] { ranks }
    func injuryReports(season: Int) async -> [String: InjuryReport] { reports }
}

/// The schedule is the keystone: without it a real league has no opponent, no
/// kickoff time and therefore no weather or matchup analysis. These check that
/// it actually reaches the player contexts.
final class ScheduleEnrichmentTests: XCTestCase {

    private func makeService(
        context: StubContextProvider,
        research: ResearchProvider = EmptyResearchProvider()
    ) -> (AnalysisService, League) {
        let league = Fixtures.league()
        // Players with no environment at all — nothing knows who they play.
        var kc = Fixtures.context(id: "12345", position: .tightEnd, team: "KC")
        kc.environment = nil
        var lv = Fixtures.context(id: "67890", position: .wideReceiver, team: "LV")
        lv.environment = nil

        let team = Fixtures.team(entries: [(kc, .tightEnd), (lv, .wideReceiver)])
        let provider = BareFantasyProvider(
            leagueValue: league, team: team, opponent: nil, freeAgentPool: []
        )
        let service = AnalysisService(
            fantasyProvider: provider,
            researchProvider: research,
            contextProvider: context,
            cache: NullCache()
        )
        return (service, league)
    }

    private let game = NFLGame(
        id: "g1", homeTeamAbbreviation: "KC", awayTeamAbbreviation: "LV",
        kickoff: Date(timeIntervalSince1970: 1_800_000_000), isIndoor: false,
        overUnder: 47.5, homeSpread: -7.5
    )

    func testScheduleGivesPlayersAnOpponentTheyDidNotHave() async throws {
        let (service, league) = makeService(context: StubContextProvider(scheduled: [game]))

        let snapshot = try await service.loadSnapshot(
            leagueID: league.id, teamID: "team-1", season: 2026, week: 6, allowCache: false
        )
        let contexts = snapshot.matchup.userTeam.roster.map(\.context)

        let kansasCity = try XCTUnwrap(contexts.first { $0.player.teamAbbreviation == "KC" })
        let raiders = try XCTUnwrap(contexts.first { $0.player.teamAbbreviation == "LV" })

        XCTAssertEqual(kansasCity.environment?.opponentAbbreviation, "LV")
        XCTAssertEqual(kansasCity.environment?.isHome, true)
        XCTAssertEqual(raiders.environment?.opponentAbbreviation, "KC")
        XCTAssertEqual(raiders.environment?.isHome, false)
        XCTAssertNotNil(kansasCity.environment?.kickoff)
        XCTAssertEqual(kansasCity.environment?.opponentLabel, "vs LV")
        XCTAssertEqual(raiders.environment?.opponentLabel, "@ KC")
    }

    func testBettingLineIsAppliedFromEachTeamsPerspective() async throws {
        let (service, league) = makeService(context: StubContextProvider(scheduled: [game]))

        let snapshot = try await service.loadSnapshot(
            leagueID: league.id, teamID: "team-1", season: 2026, week: 6, allowCache: false
        )
        let contexts = snapshot.matchup.userTeam.roster.map(\.context)
        let kansasCity = try XCTUnwrap(contexts.first { $0.player.teamAbbreviation == "KC" })
        let raiders = try XCTUnwrap(contexts.first { $0.player.teamAbbreviation == "LV" })

        XCTAssertEqual(kansasCity.environment?.betting.spread, -7.5)
        XCTAssertEqual(raiders.environment?.betting.spread, 7.5)
        XCTAssertEqual(kansasCity.environment?.betting.overUnder, 47.5)
    }

    func testDepthChartAndInjuryReportJoinOntoTheRoster() async throws {
        let context = StubContextProvider(
            scheduled: [game],
            ranks: ["12345": 3],
            reports: ["67890": InjuryReport(
                status: .questionable, practice: .didNotParticipate, note: "Did not practice."
            )]
        )
        let (service, league) = makeService(context: context)

        let snapshot = try await service.loadSnapshot(
            leagueID: league.id, teamID: "team-1", season: 2026, week: 6, allowCache: false
        )
        let contexts = snapshot.matchup.userTeam.roster.map(\.context)

        let kansasCity = try XCTUnwrap(contexts.first { $0.player.id.value == "12345" })
        let raiders = try XCTUnwrap(contexts.first { $0.player.id.value == "67890" })

        XCTAssertEqual(kansasCity.player.depthChartRank, 3)
        XCTAssertEqual(raiders.player.injury.status, .questionable)
        XCTAssertEqual(raiders.player.injury.practice, .didNotParticipate)
        // A questionable player who didn't practice is a much worse bet than one
        // who did, and the projection has to reflect that.
        XCTAssertLessThan(raiders.player.injury.effectivePlayProbability, 0.5)
    }

    func testAnEmptyScheduleLeavesEverythingUntouchedRatherThanBreaking() async throws {
        let (service, league) = makeService(context: StubContextProvider(scheduled: []))

        let snapshot = try await service.loadSnapshot(
            leagueID: league.id, teamID: "team-1", season: 2026, week: 6, allowCache: false
        )

        XCTAssertEqual(snapshot.matchup.userTeam.roster.count, 2)
        for entry in snapshot.matchup.userTeam.roster {
            XCTAssertNil(entry.context.environment)
        }
    }

    func testAnalysisStillProducesAPlanWithNoNFLContextAtAll() async throws {
        let (service, league) = makeService(context: StubContextProvider(scheduled: []))
        let snapshot = try await service.loadSnapshot(
            leagueID: league.id, teamID: "team-1", season: 2026, week: 6, allowCache: false
        )

        let analysis = await service.analyze(snapshot: snapshot, allowCache: false)

        // Missing NFL context degrades the explanation; it must never fail the week.
        XCTAssertFalse(analysis.plan.headline.isEmpty)
        XCTAssertFalse(analysis.plan.moves.isEmpty)
    }
}
