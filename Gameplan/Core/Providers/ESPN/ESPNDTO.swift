import Foundation

/// Wire types for ESPN's fantasy read API.
///
/// Every field is optional. ESPN omits large parts of the payload depending on
/// which views were requested and on league settings, so the mapper is written to
/// cope with absence everywhere rather than to assume a shape.
enum ESPNDTO {

    struct LeagueResponse: Decodable {
        var id: Int?
        var seasonId: Int?
        var scoringPeriodId: Int?
        var settings: Settings?
        var teams: [Team]?
        var members: [Member]?
        var schedule: [ScheduleItem]?
        var status: Status?
    }

    struct Status: Decodable {
        var currentMatchupPeriod: Int?
        var latestScoringPeriod: Int?
        var isActive: Bool?
    }

    struct Member: Decodable {
        var id: String?
        var displayName: String?
        var firstName: String?
        var lastName: String?
    }

    struct Settings: Decodable {
        var name: String?
        var size: Int?
        var isPublic: Bool?
        var scoringSettings: ScoringSettingsDTO?
        var rosterSettings: RosterSettingsDTO?
        var scheduleSettings: ScheduleSettingsDTO?
        var acquisitionSettings: AcquisitionSettingsDTO?
        var tradeSettings: TradeSettingsDTO?
    }

    struct ScoringSettingsDTO: Decodable {
        var scoringItems: [ScoringItem]?
        /// 0 = standard, 1 = PPR-ish, 2 = points, 3 = custom. Only used as a
        /// fallback when the item list is missing.
        var scoringType: Int?
    }

    struct ScoringItem: Decodable {
        var statId: Int?
        var points: Double?
        var pointsOverrides: [String: Double]?
    }

    struct RosterSettingsDTO: Decodable {
        /// Keys are ESPN lineup slot IDs as strings.
        var lineupSlotCounts: [String: Int]?
    }

    struct ScheduleSettingsDTO: Decodable {
        var matchupPeriodCount: Int?
        var playoffTeamCount: Int?
        var playoffMatchupPeriodLength: Int?
    }

    struct AcquisitionSettingsDTO: Decodable {
        var acquisitionBudget: Int?
        /// True when the league uses FAAB bidding.
        var isUsingAcquisitionBudget: Bool?
        var waiverProcessDays: [String]?
        var waiverHours: Int?
    }

    struct TradeSettingsDTO: Decodable {
        var deadlineDate: Double?
    }

    struct Team: Decodable {
        var id: Int?
        var abbrev: String?
        var name: String?
        var location: String?
        var nickname: String?
        var playoffSeed: Int?
        var record: Record?
        var roster: RosterDTO?
        var owners: [String]?
        var transactionCounter: TransactionCounter?
        var waiverRank: Int?
    }

    struct TransactionCounter: Decodable {
        var acquisitionBudgetSpent: Int?
    }

    struct Record: Decodable {
        var overall: RecordEntry?
    }

    struct RecordEntry: Decodable {
        var wins: Int?
        var losses: Int?
        var ties: Int?
        var pointsFor: Double?
        var pointsAgainst: Double?
    }

    struct RosterDTO: Decodable {
        var entries: [RosterEntryDTO]?
    }

    struct RosterEntryDTO: Decodable {
        var playerId: Int?
        var lineupSlotId: Int?
        var acquisitionType: String?
        var playerPoolEntry: PlayerPoolEntry?
    }

    struct PlayerPoolEntry: Decodable {
        var id: Int?
        var player: PlayerDTO?
        var appliedStatTotal: Double?
        /// Percentage of leagues where the player is rostered, 0...100.
        var onTeamId: Int?
    }

    struct PlayerDTO: Decodable {
        var id: Int?
        var firstName: String?
        var lastName: String?
        var fullName: String?
        var defaultPositionId: Int?
        var proTeamId: Int?
        var jersey: String?
        var injured: Bool?
        var injuryStatus: String?
        var eligibleSlots: [Int]?
        var stats: [StatEntry]?
        var ownership: Ownership?
    }

    struct Ownership: Decodable {
        var percentOwned: Double?
        var percentChange: Double?
        var percentStarted: Double?
    }

    /// ESPN mixes actual results and projections into one array. `statSourceId`
    /// is 0 for actual and 1 for projected; `statSplitTypeId` is 1 for a single
    /// week and 0 for a season total.
    struct StatEntry: Decodable {
        var scoringPeriodId: Int?
        var seasonId: Int?
        var statSourceId: Int?
        var statSplitTypeId: Int?
        var appliedTotal: Double?
        var appliedAverage: Double?
        var stats: [String: Double]?
    }

    struct ScheduleItem: Decodable {
        var id: Int?
        var matchupPeriodId: Int?
        var winner: String?
        var home: ScheduleSide?
        var away: ScheduleSide?
    }

    struct ScheduleSide: Decodable {
        var teamId: Int?
        var totalPoints: Double?
    }

    /// Response shape of the league-list navigation endpoint.
    struct LeagueListEntry: Decodable {
        var id: Int?
        var settings: Settings?
        var seasonId: Int?
        var teams: [Team]?
    }
}
