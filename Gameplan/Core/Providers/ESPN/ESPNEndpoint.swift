import Foundation

/// Request construction for ESPN's fantasy read API.
///
/// Important, and documented for the user in the app's ESPN settings screen:
/// ESPN publishes no supported public API for fantasy football. The endpoints
/// below are the read-only ones the ESPN web app itself calls. They are stable in
/// practice but are not a contract, and they can change without notice.
///
/// That is precisely why the app talks to `FantasyDataProvider` rather than to
/// ESPN directly — if these break, or if a supported API appears, only this
/// folder changes.
///
/// The app never asks for an ESPN password. Private leagues are read using the
/// `espn_s2` and `SWID` cookies the user copies from their own browser session,
/// which stay in the Keychain on device and are sent to no one but ESPN.
struct ESPNEndpoint {
    static let host = "lm-api-reads.fantasy.espn.com"

    enum View: String {
        case settings = "mSettings"
        case team = "mTeam"
        case roster = "mRoster"
        case matchup = "mMatchupScore"
        case schedule = "mSchedule"
        case boxscore = "mBoxscore"
        case playerInfo = "kona_player_info"
        case status = "mStatus"
        case navigation = "mNav"
    }

    var season: Int
    var leagueID: String
    var views: [View]
    var scoringPeriod: Int?

    func url() throws -> URL {
        var components = URLComponents()
        components.scheme = "https"
        components.host = Self.host
        components.path = "/apis/v3/games/ffl/seasons/\(season)/segments/0/leagues/\(leagueID)"

        var items = views.map { URLQueryItem(name: "view", value: $0.rawValue) }
        if let scoringPeriod {
            items.append(URLQueryItem(name: "scoringPeriodId", value: String(scoringPeriod)))
        }
        components.queryItems = items

        guard let url = components.url else {
            throw FantasyDataError.unsupported("Couldn't build the ESPN request URL.")
        }
        return url
    }

    /// The endpoint that lists the leagues a set of credentials can see.
    static func leagueListURL(season: Int, swid: String) throws -> URL {
        var components = URLComponents()
        components.scheme = "https"
        components.host = host
        components.path = "/apis/v3/games/ffl/seasons/\(season)/segments/0/leagues"
        components.queryItems = [
            URLQueryItem(name: "view", value: View.navigation.rawValue),
            URLQueryItem(name: "swid", value: swid)
        ]
        guard let url = components.url else {
            throw FantasyDataError.unsupported("Couldn't build the ESPN league list URL.")
        }
        return url
    }
}
