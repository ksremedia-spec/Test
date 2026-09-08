import Foundation

/// Stable identity for a player, namespaced by the provider that produced it so
/// IDs from different sources can never silently collide.
struct PlayerID: Hashable, Sendable, CustomStringConvertible {
    var source: String
    var value: String

    init(source: String, value: String) {
        self.source = source
        self.value = value
    }

    var description: String { "\(source):\(value)" }
}

extension PlayerID: RawRepresentable {
    init?(rawValue: String) {
        let parts = rawValue.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        guard parts.count == 2 else { return nil }
        self.init(source: String(parts[0]), value: String(parts[1]))
    }

    var rawValue: String { description }
}

/// Encoded as the single string `source:value` rather than as an object. Written
/// out explicitly so the on-disk shape is obvious and stable, rather than
/// depending on which of two possible synthesised conformances the compiler picks.
extension PlayerID: Codable {
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let raw = try container.decode(String.self)
        guard let decoded = PlayerID(rawValue: raw) else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Expected a player ID of the form source:value, got \(raw)."
            )
        }
        self = decoded
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

/// Identity and status for a single player. Deliberately free of analysis — the
/// engine works on `PlayerContext`, which wraps this with evidence.
struct Player: Codable, Hashable, Identifiable, Sendable {
    var id: PlayerID
    var firstName: String
    var lastName: String
    var position: Position
    var teamAbbreviation: String
    var jerseyNumber: Int?
    var byeWeek: Int?
    var injury: InjuryReport
    /// Rank on the team's depth chart at this position, 1-based. Nil when unknown.
    var depthChartRank: Int?
    /// Share of leagues where the player is rostered, 0...1. Nil when unknown.
    var rosteredPercentage: Double?
    /// Change in roster percentage over the last week, in percentage points.
    var rosteredPercentageChange: Double?

    init(
        id: PlayerID,
        firstName: String,
        lastName: String,
        position: Position,
        teamAbbreviation: String,
        jerseyNumber: Int? = nil,
        byeWeek: Int? = nil,
        injury: InjuryReport = .healthy,
        depthChartRank: Int? = nil,
        rosteredPercentage: Double? = nil,
        rosteredPercentageChange: Double? = nil
    ) {
        self.id = id
        self.firstName = firstName
        self.lastName = lastName
        self.position = position
        self.teamAbbreviation = teamAbbreviation
        self.jerseyNumber = jerseyNumber
        self.byeWeek = byeWeek
        self.injury = injury
        self.depthChartRank = depthChartRank
        self.rosteredPercentage = rosteredPercentage
        self.rosteredPercentageChange = rosteredPercentageChange
    }

    var fullName: String {
        firstName.isEmpty ? lastName : "\(firstName) \(lastName)"
    }

    /// "A. Brown" — used in dense rows where the full name would wrap.
    var shortName: String {
        guard let initial = firstName.first else { return lastName }
        return "\(initial). \(lastName)"
    }

    var team: NFLTeam { NFLTeam.team(abbreviation: teamAbbreviation) }

    func isOnBye(week: Int) -> Bool { byeWeek == week }

    /// A player is unusable this week if they are out, on IR, or on bye.
    func isUnavailable(week: Int) -> Bool {
        injury.status.isUnavailable || isOnBye(week: week)
    }
}
