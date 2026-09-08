import XCTest
@testable import Gameplan

final class NFLGameTests: XCTestCase {

    private let game = NFLGame(
        id: "1", homeTeamAbbreviation: "KC", awayTeamAbbreviation: "LV",
        kickoff: Date(timeIntervalSince1970: 1_800_000_000), isIndoor: false,
        overUnder: 47.5, homeSpread: -7.5
    )

    func testOpponentAndVenueResolveFromEitherSide() {
        XCTAssertEqual(game.opponent(of: "KC"), "LV")
        XCTAssertEqual(game.opponent(of: "LV"), "KC")
        XCTAssertNil(game.opponent(of: "SF"))
        XCTAssertTrue(game.isHome("KC"))
        XCTAssertFalse(game.isHome("LV"))
        XCTAssertTrue(game.involves("LV"))
        XCTAssertFalse(game.involves("SF"))
    }

    func testSpreadFlipsSignForTheAwayTeam() {
        // A home favorite is an away underdog. Getting this backwards would
        // invert every game-script read the engine makes.
        XCTAssertEqual(game.bettingContext(for: "KC").spread, -7.5)
        XCTAssertEqual(game.bettingContext(for: "LV").spread, 7.5)
        XCTAssertEqual(game.bettingContext(for: "KC").overUnder, 47.5)
    }

    func testImpliedTeamTotalFollowsTheSpread() {
        let favourite = game.bettingContext(for: "KC")
        let underdog = game.bettingContext(for: "LV")
        // 47.5 total with a 7.5 spread splits 27.5 / 20.
        XCTAssertEqual(favourite.impliedTeamTotal ?? 0, 27.5, accuracy: 0.001)
        XCTAssertEqual(underdog.impliedTeamTotal ?? 0, 20.0, accuracy: 0.001)
        XCTAssertEqual(favourite.favorsPassing, false)
        XCTAssertEqual(underdog.favorsPassing, true)
    }

    func testMissingSpreadStillCarriesTheTotal() {
        let noLine = NFLGame(id: "2", homeTeamAbbreviation: "GB", awayTeamAbbreviation: "CHI", overUnder: 41)
        let context = noLine.bettingContext(for: "GB")
        XCTAssertEqual(context.overUnder, 41)
        XCTAssertNil(context.spread)
        XCTAssertNil(context.impliedTeamTotal)
    }
}

final class ESPNPublicDecodingTests: XCTestCase {

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    func testNumbersDecodeWhetherQuotedOrNot() throws {
        struct Wrapper: Decodable { var a: LooseNumber; var b: LooseNumber; var c: LooseNumber }
        let wrapper = try decode(Wrapper.self, #"{"a": -7.5, "b": "-7.5", "c": "+3"}"#)
        XCTAssertEqual(wrapper.a.value, -7.5)
        XCTAssertEqual(wrapper.b.value, -7.5)
        XCTAssertEqual(wrapper.c.value, 3)
    }

    func testUnparseableNumbersBecomeNilRatherThanThrowing() throws {
        struct Wrapper: Decodable { var a: LooseNumber }
        // "EVEN" and "OFF" both appear in real odds payloads.
        XCTAssertNil(try decode(Wrapper.self, #"{"a": "EVEN"}"#).a.value)
        XCTAssertNil(try decode(Wrapper.self, #"{"a": null}"#).a.value)
    }

    func testIdentifiersDecodeWhetherNumericOrString() throws {
        struct Wrapper: Decodable { var a: LooseID; var b: LooseID }
        let wrapper = try decode(Wrapper.self, #"{"a": 401671789, "b": "401671789"}"#)
        XCTAssertEqual(wrapper.a.value, "401671789")
        XCTAssertEqual(wrapper.b.value, "401671789")
    }

    func testDatesParseAcrossTheShapesESPNUses() {
        XCTAssertNotNil(ESPNPublicDTO.date(from: "2026-09-13T17:00Z"))
        XCTAssertNotNil(ESPNPublicDTO.date(from: "2026-09-13T17:00:00Z"))
        XCTAssertNotNil(ESPNPublicDTO.date(from: "2026-09-13T17:00:00.000Z"))
        XCTAssertNil(ESPNPublicDTO.date(from: nil))
        XCTAssertNil(ESPNPublicDTO.date(from: ""))
    }

    func testInjuryStatusMapsKnownWordingAndIgnoresTheRest() {
        XCTAssertEqual(ESPNPublicDTO.injuryStatus(from: "QUESTIONABLE"), .questionable)
        XCTAssertEqual(ESPNPublicDTO.injuryStatus(from: "day-to-day"), .questionable)
        XCTAssertEqual(ESPNPublicDTO.injuryStatus(from: "Injured Reserve"), nil)
        XCTAssertEqual(ESPNPublicDTO.injuryStatus(from: "INJURED_RESERVE"), .injuredReserve)
        // Unknown wording must not be silently reported as healthy.
        XCTAssertNil(ESPNPublicDTO.injuryStatus(from: "SOMETHING_NEW"))
        XCTAssertNil(ESPNPublicDTO.injuryStatus(from: nil))
    }

    func testPracticeParticipationIsReadFromTheComment() {
        XCTAssertEqual(
            ESPNPublicDTO.practice(from: "Smith did not practice Wednesday."), .didNotParticipate)
        XCTAssertEqual(
            ESPNPublicDTO.practice(from: "Was a limited participant on Thursday."), .limited)
        XCTAssertEqual(
            ESPNPublicDTO.practice(from: "Returned to a full practice Friday."), .full)
        XCTAssertNil(ESPNPublicDTO.practice(from: "Is expected to play."))
        XCTAssertNil(ESPNPublicDTO.practice(from: nil))
    }

    func testScoreboardDecodesIntoGames() throws {
        // Shaped after ESPN's documented scoreboard response. If the real payload
        // differs, DiagnosticsLog captures it and this fixture gets corrected.
        let json = """
        {"events":[{"id":"401671789","date":"2026-09-13T17:00Z","competitions":[{
          "id":"401671789","date":"2026-09-13T17:00Z",
          "venue":{"fullName":"Arrowhead Stadium","indoor":false},
          "competitors":[
            {"homeAway":"home","team":{"id":"12","abbreviation":"KC"}},
            {"homeAway":"away","team":{"id":"13","abbreviation":"LV"}}],
          "odds":[{"details":"KC -7.5","overUnder":47.5,"spread":-7.5,
                   "provider":{"name":"Book","priority":1}}]}]}]}
        """
        let board = try decode(ESPNPublicDTO.Scoreboard.self, json)
        let competition = try XCTUnwrap(board.events?.first?.competitions?.first)

        XCTAssertEqual(competition.competitors?.first(where: { $0.isHome })?.team?.abbreviation, "KC")
        XCTAssertEqual(competition.competitors?.first(where: { !$0.isHome })?.team?.abbreviation, "LV")
        XCTAssertEqual(competition.venue?.indoor, false)
        XCTAssertEqual(competition.odds?.first?.overUnder?.value, 47.5)
        XCTAssertEqual(competition.odds?.first?.spread?.value, -7.5)
        XCTAssertNotNil(ESPNPublicDTO.date(from: competition.date))
    }

    func testCoreApiCollectionDecodesLinksAndInlineObjects() throws {
        // The core API usually returns links, but sometimes inlines the record.
        let linked = try decode(
            ESPNPublicDTO.Collection<ESPNPublicDTO.RefOrValue<ESPNPublicDTO.Injury>>.self,
            #"{"count":1,"items":[{"$ref":"https://example.test/injuries/1"}]}"#
        )
        XCTAssertEqual(linked.items?.first?.ref, "https://example.test/injuries/1")
        XCTAssertNil(linked.items?.first?.value?.status)

        let inlineJSON = """
        {"count":1,"items":[{"status":"QUESTIONABLE","athlete":{"id":"4241"},
          "longComment":"Was a limited participant Thursday."}]}
        """
        let inline = try decode(
            ESPNPublicDTO.Collection<ESPNPublicDTO.RefOrValue<ESPNPublicDTO.Injury>>.self,
            inlineJSON
        )
        let injury = try XCTUnwrap(inline.items?.first?.value)
        XCTAssertEqual(injury.status, "QUESTIONABLE")
        XCTAssertEqual(injury.athlete?.id?.value, "4241")
        XCTAssertEqual(ESPNPublicDTO.practice(from: injury.longComment), .limited)
    }
}

final class ESPNPublicEndpointTests: XCTestCase {

    func testScoreboardURLCarriesSeasonAndWeek() throws {
        let url = try XCTUnwrap(ESPNPublicEndpoint.scoreboard(season: 2026, week: 6))
        let string = url.absoluteString
        XCTAssertTrue(string.contains("site.api.espn.com"))
        XCTAssertTrue(string.contains("dates=2026"))
        XCTAssertTrue(string.contains("week=6"))
        XCTAssertTrue(string.contains("seasontype=2"))
    }

    func testTeamIDsAreSharedWithTheFantasyFeed() {
        // The fantasy feed's proTeamId and the public API's team id are the same
        // numbers, which is what lets injury and depth-chart data join onto a
        // league roster at all.
        XCTAssertEqual(ESPNPublicEndpoint.teamID(for: "KC"), 12)
        XCTAssertEqual(ESPNPublicEndpoint.teamID(for: "BAL"), 33)
        XCTAssertEqual(ESPNPublicEndpoint.teamID(for: "HOU"), 34)
        // Aliases resolve through the same normalisation as everywhere else.
        XCTAssertEqual(ESPNPublicEndpoint.teamID(for: "WAS"), ESPNPublicEndpoint.teamID(for: "WSH"))
        XCTAssertNil(ESPNPublicEndpoint.teamID(for: "FA"))
    }

    func testEveryRealTeamHasAnID() {
        for team in NFLTeam.all {
            XCTAssertNotNil(
                ESPNPublicEndpoint.teamID(for: team.abbreviation),
                "No ESPN team id for \(team.abbreviation)"
            )
        }
    }
}
