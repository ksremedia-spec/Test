import Foundation

/// A number that ESPN might send as a JSON number or as a quoted string.
///
/// These feeds are inconsistent about it — the same field can arrive either way
/// depending on the endpoint. Decoding straight into `Double` works until the day
/// it doesn't, and the failure is a silently empty result rather than an error,
/// so every numeric field here goes through this.
struct LooseNumber: Decodable, Hashable, Sendable {
    var value: Double?

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let number = try? container.decode(Double.self) { value = number; return }
        if let text = try? container.decode(String.self) {
            // "-7.5", "+3", "EVEN", "OFF" are all things that show up here.
            value = Double(text.replacingOccurrences(of: "+", with: ""))
            return
        }
        value = nil
    }
}

/// Same idea for identifiers, which arrive as numbers in some payloads and
/// strings in others.
struct LooseID: Decodable, Hashable, Sendable {
    var value: String?

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let text = try? container.decode(String.self) { value = text; return }
        if let number = try? container.decode(Int.self) { value = String(number); return }
        value = nil
    }
}

/// Wire types for ESPN's public, unauthenticated NFL feeds.
///
/// Written from community documentation of endpoints ESPN does not publish a
/// spec for, so every field is optional and the mapping below tolerates absence
/// everywhere. Where these turn out to be wrong, `DiagnosticsLog` keeps the real
/// payload so it can be corrected against reality rather than guessed at again.
enum ESPNPublicDTO {

    // MARK: - Scoreboard

    struct Scoreboard: Decodable {
        var events: [Event]?
    }

    struct Event: Decodable {
        var id: LooseID?
        var date: String?
        var competitions: [Competition]?
    }

    struct Competition: Decodable {
        var id: LooseID?
        var date: String?
        var venue: Venue?
        var competitors: [Competitor]?
        var odds: [Odds]?
    }

    struct Venue: Decodable {
        var fullName: String?
        var indoor: Bool?
    }

    struct Competitor: Decodable {
        var homeAway: String?
        var team: TeamRef?

        var isHome: Bool { homeAway?.lowercased() == "home" }
    }

    struct TeamRef: Decodable {
        var id: LooseID?
        var abbreviation: String?
        var displayName: String?
    }

    struct Odds: Decodable {
        var details: String?
        var overUnder: LooseNumber?
        var spread: LooseNumber?
        var homeTeamOdds: TeamOdds?
        var awayTeamOdds: TeamOdds?
        var provider: OddsProvider?
    }

    struct OddsProvider: Decodable {
        var name: String?
        var priority: Int?
    }

    struct TeamOdds: Decodable {
        var favorite: Bool?
        var underdog: Bool?
        var spreadOdds: LooseNumber?
    }

    // MARK: - Core API envelopes

    /// ESPN's core API returns collections as a list of links rather than a list
    /// of objects. Each item is usually `{"$ref": "https://..."}`, and the real
    /// record has to be fetched separately — so reading one of these costs one
    /// request for the index plus one per item.
    struct Collection<Item: Decodable>: Decodable {
        var count: Int?
        var items: [Item]?
    }

    /// An item that may be either the object itself or a link to it.
    struct RefOrValue<Value: Decodable>: Decodable {
        var ref: String?
        var value: Value?

        private enum CodingKeys: String, CodingKey { case ref = "$ref" }

        init(from decoder: Decoder) throws {
            if let container = try? decoder.container(keyedBy: CodingKeys.self),
               let ref = try? container.decodeIfPresent(String.self, forKey: .ref) {
                self.ref = ref
            }
            self.value = try? Value(from: decoder)
        }
    }

    // MARK: - Injuries

    struct Injury: Decodable {
        var id: LooseID?
        var status: String?
        var date: String?
        var longComment: String?
        var shortComment: String?
        var athlete: AthleteRef?
        var type: InjuryType?
        var details: InjuryDetails?
    }

    struct InjuryType: Decodable {
        var name: String?
        var description: String?
        var abbreviation: String?
    }

    struct InjuryDetails: Decodable {
        var type: String?
        var location: String?
        var detail: String?
        var side: String?
        var returnDate: String?
        var fantasyStatus: FantasyStatus?
    }

    struct FantasyStatus: Decodable {
        var description: String?
        var abbreviation: String?
    }

    struct AthleteRef: Decodable {
        var id: LooseID?
        var ref: String?
        var displayName: String?

        private enum CodingKeys: String, CodingKey {
            case id, displayName
            case ref = "$ref"
        }
    }

    // MARK: - Depth charts

    struct DepthChart: Decodable {
        var items: [DepthChartGroup]?
    }

    struct DepthChartGroup: Decodable {
        var name: String?
        var positions: [String: DepthChartPosition]?
    }

    struct DepthChartPosition: Decodable {
        var position: PositionRef?
        var athletes: [DepthChartAthlete]?
    }

    struct PositionRef: Decodable {
        var name: String?
        var abbreviation: String?
    }

    struct DepthChartAthlete: Decodable {
        var rank: Int?
        var athlete: AthleteRef?
    }
}

extension ESPNPublicDTO {
    /// ESPN timestamps come through in a couple of shapes across these feeds.
    static func date(from raw: String?) -> Date? {
        guard let raw, !raw.isEmpty else { return nil }
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFraction.date(from: raw) { return date }

        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        if let date = plain.date(from: raw) { return date }

        // Some feeds use "2026-09-13T17:00Z" with no seconds, which ISO8601
        // parsing rejects.
        let fallback = DateFormatter()
        fallback.locale = Locale(identifier: "en_US_POSIX")
        fallback.timeZone = TimeZone(identifier: "UTC")
        for format in ["yyyy-MM-dd'T'HH:mm'Z'", "yyyy-MM-dd'T'HH:mmZ", "yyyy-MM-dd"] {
            fallback.dateFormat = format
            if let date = fallback.date(from: raw) { return date }
        }
        return nil
    }

    /// Maps ESPN's injury wording onto the app's status. Their vocabulary is not
    /// fixed, so anything unrecognised falls back to active rather than guessing.
    static func injuryStatus(from raw: String?) -> InjuryStatus? {
        guard let raw = raw?.uppercased().replacingOccurrences(of: "-", with: "_") else { return nil }
        switch raw {
        case "ACTIVE", "NORMAL": return .active
        case "PROBABLE": return .probable
        case "QUESTIONABLE", "DAY_TO_DAY": return .questionable
        case "DOUBTFUL": return .doubtful
        case "OUT": return .out
        case "INJURED_RESERVE", "INJURY_RESERVE", "IR": return .injuredReserve
        case "SUSPENSION", "SUSPENDED": return .suspended
        case "PHYSICALLY_UNABLE_TO_PERFORM", "PUP": return .physicallyUnableToPerform
        default: return nil
        }
    }

    /// Reads practice participation out of the free-text comment.
    ///
    /// ESPN does not appear to publish this as its own field, but the beat
    /// comment usually states it. This is a best-effort read of prose, so it is
    /// treated as weaker evidence than a structured value would be.
    static func practice(from comment: String?) -> PracticeParticipation? {
        guard let text = comment?.lowercased() else { return nil }
        if text.contains("did not practice") || text.contains("dnp") { return .didNotParticipate }
        if text.contains("limited practice") || text.contains("limited participant") { return .limited }
        if text.contains("full practice") || text.contains("full participant") { return .full }
        return nil
    }
}
