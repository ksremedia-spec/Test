import Foundation

/// A real NFL franchise. Only stable, public reference data lives here:
/// abbreviation, name, whether the home stadium is enclosed, and the stadium
/// coordinate used to look up game-day weather.
///
/// Bye weeks are *not* hard-coded — they change every season and are supplied by
/// the fantasy data provider.
struct NFLTeam: Codable, Hashable, Identifiable, Sendable {
    var abbreviation: String
    var location: String
    var nickname: String
    /// True for domes and retractable roofs that are usually closed. Weather is
    /// not a factor for these games.
    var isIndoor: Bool
    var latitude: Double
    var longitude: Double

    var id: String { abbreviation }
    var fullName: String { "\(location) \(nickname)" }

    init(
        abbreviation: String,
        location: String,
        nickname: String,
        isIndoor: Bool = false,
        latitude: Double = 0,
        longitude: Double = 0
    ) {
        self.abbreviation = abbreviation
        self.location = location
        self.nickname = nickname
        self.isIndoor = isIndoor
        self.latitude = latitude
        self.longitude = longitude
    }
}

extension NFLTeam {
    /// Static reference table of the 32 franchises plus a placeholder used when a
    /// provider hands back a team we do not recognise.
    static let all: [NFLTeam] = [
        NFLTeam(abbreviation: "ARI", location: "Arizona", nickname: "Cardinals", isIndoor: true, latitude: 33.5276, longitude: -112.2626),
        NFLTeam(abbreviation: "ATL", location: "Atlanta", nickname: "Falcons", isIndoor: true, latitude: 33.7554, longitude: -84.4008),
        NFLTeam(abbreviation: "BAL", location: "Baltimore", nickname: "Ravens", latitude: 39.2780, longitude: -76.6227),
        NFLTeam(abbreviation: "BUF", location: "Buffalo", nickname: "Bills", latitude: 42.7738, longitude: -78.7870),
        NFLTeam(abbreviation: "CAR", location: "Carolina", nickname: "Panthers", latitude: 35.2258, longitude: -80.8528),
        NFLTeam(abbreviation: "CHI", location: "Chicago", nickname: "Bears", latitude: 41.8623, longitude: -87.6167),
        NFLTeam(abbreviation: "CIN", location: "Cincinnati", nickname: "Bengals", latitude: 39.0955, longitude: -84.5161),
        NFLTeam(abbreviation: "CLE", location: "Cleveland", nickname: "Browns", latitude: 41.5061, longitude: -81.6995),
        NFLTeam(abbreviation: "DAL", location: "Dallas", nickname: "Cowboys", isIndoor: true, latitude: 32.7473, longitude: -97.0945),
        NFLTeam(abbreviation: "DEN", location: "Denver", nickname: "Broncos", latitude: 39.7439, longitude: -105.0201),
        NFLTeam(abbreviation: "DET", location: "Detroit", nickname: "Lions", isIndoor: true, latitude: 42.3400, longitude: -83.0456),
        NFLTeam(abbreviation: "GB", location: "Green Bay", nickname: "Packers", latitude: 44.5013, longitude: -88.0622),
        NFLTeam(abbreviation: "HOU", location: "Houston", nickname: "Texans", isIndoor: true, latitude: 29.6847, longitude: -95.4107),
        NFLTeam(abbreviation: "IND", location: "Indianapolis", nickname: "Colts", isIndoor: true, latitude: 39.7601, longitude: -86.1639),
        NFLTeam(abbreviation: "JAX", location: "Jacksonville", nickname: "Jaguars", latitude: 30.3239, longitude: -81.6373),
        NFLTeam(abbreviation: "KC", location: "Kansas City", nickname: "Chiefs", latitude: 39.0489, longitude: -94.4839),
        NFLTeam(abbreviation: "LAC", location: "Los Angeles", nickname: "Chargers", isIndoor: true, latitude: 33.9535, longitude: -118.3392),
        NFLTeam(abbreviation: "LAR", location: "Los Angeles", nickname: "Rams", isIndoor: true, latitude: 33.9535, longitude: -118.3392),
        NFLTeam(abbreviation: "LV", location: "Las Vegas", nickname: "Raiders", isIndoor: true, latitude: 36.0909, longitude: -115.1833),
        NFLTeam(abbreviation: "MIA", location: "Miami", nickname: "Dolphins", latitude: 25.9580, longitude: -80.2389),
        NFLTeam(abbreviation: "MIN", location: "Minnesota", nickname: "Vikings", isIndoor: true, latitude: 44.9736, longitude: -93.2575),
        NFLTeam(abbreviation: "NE", location: "New England", nickname: "Patriots", latitude: 42.0909, longitude: -71.2643),
        NFLTeam(abbreviation: "NO", location: "New Orleans", nickname: "Saints", isIndoor: true, latitude: 29.9511, longitude: -90.0812),
        NFLTeam(abbreviation: "NYG", location: "New York", nickname: "Giants", latitude: 40.8135, longitude: -74.0745),
        NFLTeam(abbreviation: "NYJ", location: "New York", nickname: "Jets", latitude: 40.8135, longitude: -74.0745),
        NFLTeam(abbreviation: "PHI", location: "Philadelphia", nickname: "Eagles", latitude: 39.9008, longitude: -75.1675),
        NFLTeam(abbreviation: "PIT", location: "Pittsburgh", nickname: "Steelers", latitude: 40.4468, longitude: -80.0158),
        NFLTeam(abbreviation: "SEA", location: "Seattle", nickname: "Seahawks", latitude: 47.5952, longitude: -122.3316),
        NFLTeam(abbreviation: "SF", location: "San Francisco", nickname: "49ers", latitude: 37.4033, longitude: -121.9694),
        NFLTeam(abbreviation: "TB", location: "Tampa Bay", nickname: "Buccaneers", latitude: 27.9759, longitude: -82.5033),
        NFLTeam(abbreviation: "TEN", location: "Tennessee", nickname: "Titans", latitude: 36.1665, longitude: -86.7713),
        NFLTeam(abbreviation: "WSH", location: "Washington", nickname: "Commanders", latitude: 38.9077, longitude: -76.8645)
    ]

    static let unknown = NFLTeam(abbreviation: "FA", location: "Free", nickname: "Agent")

    private static let index: [String: NFLTeam] = {
        Dictionary(uniqueKeysWithValues: all.map { ($0.abbreviation, $0) })
    }()

    /// Case-insensitive lookup with a few common aliases folded in. Returns
    /// `.unknown` rather than nil so display code never has to branch.
    static func team(abbreviation: String) -> NFLTeam {
        let key = abbreviation.uppercased().trimmingCharacters(in: .whitespaces)
        if let match = index[key] { return match }
        switch key {
        case "WAS", "WFT": return index["WSH"] ?? unknown
        case "JAC": return index["JAX"] ?? unknown
        case "OAK": return index["LV"] ?? unknown
        case "SD": return index["LAC"] ?? unknown
        case "STL": return index["LAR"] ?? unknown
        case "LA": return index["LAR"] ?? unknown
        case "GNB": return index["GB"] ?? unknown
        case "KAN": return index["KC"] ?? unknown
        case "NWE": return index["NE"] ?? unknown
        case "NOR": return index["NO"] ?? unknown
        case "SFO": return index["SF"] ?? unknown
        case "TAM": return index["TB"] ?? unknown
        default: return unknown
        }
    }
}
