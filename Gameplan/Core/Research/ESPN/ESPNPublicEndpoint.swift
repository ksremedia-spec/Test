import Foundation

/// URL construction for ESPN's public NFL feeds.
///
/// Three different hosts are involved, which is a quirk of ESPN's own history
/// rather than anything meaningful:
///
/// - `site.api.espn.com` — the scoreboard. Self-contained responses, the
///   easiest of the three to work with.
/// - `sports.core.api.espn.com` — injuries and depth charts. Returns lists of
///   links rather than lists of records, so reading a collection costs one
///   request for the index plus one per item.
/// - `site.web.api.espn.com` — per-athlete game logs and splits.
///
/// None of it needs authentication and none of it is documented by ESPN.
enum ESPNPublicEndpoint {

    /// Regular season. ESPN uses 1 for preseason, 2 for regular, 3 for postseason.
    static let regularSeason = 2

    static func scoreboard(season: Int, week: Int, seasonType: Int = regularSeason) -> URL? {
        var components = URLComponents()
        components.scheme = "https"
        components.host = "site.api.espn.com"
        components.path = "/apis/site/v2/sports/football/nfl/scoreboard"
        components.queryItems = [
            URLQueryItem(name: "dates", value: String(season)),
            URLQueryItem(name: "seasontype", value: String(seasonType)),
            URLQueryItem(name: "week", value: String(week))
        ]
        return components.url
    }

    static func injuries(teamID: Int) -> URL? {
        URL(string: "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/teams/\(teamID)/injuries?limit=100")
    }

    static func depthChart(season: Int, teamID: Int) -> URL? {
        URL(string: "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/\(season)/teams/\(teamID)/depthcharts")
    }

    static func gameLog(athleteID: String) -> URL? {
        URL(string: "https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/\(athleteID)/gamelog")
    }

    static func athleteOverview(athleteID: String) -> URL? {
        URL(string: "https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/\(athleteID)/overview")
    }

    /// ESPN's NFL team IDs.
    ///
    /// Usefully, these are the same numbers the fantasy feed uses for
    /// `proTeamId`, so the table the fantasy mapper already carries can be
    /// reused rather than maintained twice. The same is true of athlete IDs: a
    /// player's ID in a fantasy roster is their ID on the public side too, which
    /// is what makes it possible to join injury and depth-chart data onto a
    /// league roster at all.
    private static let teamIDsByAbbreviation: [String: Int] = {
        var result: [String: Int] = [:]
        for (id, abbreviation) in ESPNMapping.proTeamAbbreviations where id != 0 {
            result[abbreviation] = id
        }
        return result
    }()

    static func teamID(for abbreviation: String) -> Int? {
        teamIDsByAbbreviation[NFLTeam.team(abbreviation: abbreviation).abbreviation]
    }
}
