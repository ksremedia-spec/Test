import Foundation

/// Translates ESPN's numeric identifiers into the app's domain types.
///
/// ESPN encodes positions, teams, lineup slots and stats as integers. This table
/// is the only place in the app that knows about them.
enum ESPNMapping {

    // MARK: - Positions

    static func position(fromDefaultPositionID id: Int?) -> Position? {
        switch id {
        case 1: return .quarterback
        case 2: return .runningBack
        case 3: return .wideReceiver
        case 4: return .tightEnd
        case 5: return .kicker
        case 16: return .defense
        default: return nil
        }
    }

    /// Falls back to the eligible-slot list when the default position is missing
    /// or is one ESPN uses for flex-only players.
    static func position(fromEligibleSlots slots: [Int]?) -> Position? {
        guard let slots else { return nil }
        if slots.contains(0) { return .quarterback }
        if slots.contains(2) { return .runningBack }
        if slots.contains(4) { return .wideReceiver }
        if slots.contains(6) { return .tightEnd }
        if slots.contains(17) { return .kicker }
        if slots.contains(16) { return .defense }
        return nil
    }

    // MARK: - Lineup slots

    static func slot(fromLineupSlotID id: Int?) -> RosterSlot? {
        switch id {
        case 0: return .quarterback
        case 2: return .runningBack
        case 4: return .wideReceiver
        case 6: return .tightEnd
        case 3: return .wrTeFlex
        case 23: return .flex
        case 7: return .superflex
        case 16: return .defense
        case 17: return .kicker
        case 20: return .bench
        case 21: return .injuredReserve
        default: return nil
        }
    }

    /// Slots ESPN counts but which are not real starting positions.
    static let ignoredLineupSlotIDs: Set<Int> = [20, 21, 24]

    // MARK: - Pro teams

    /// ESPN's pro team IDs. Index 0 is "free agent".
    static let proTeamAbbreviations: [Int: String] = [
        0: "FA", 1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL",
        7: "DEN", 8: "DET", 9: "GB", 10: "TEN", 11: "IND", 12: "KC", 13: "LV",
        14: "LAR", 15: "MIA", 16: "MIN", 17: "NE", 18: "NO", 19: "NYG",
        20: "NYJ", 21: "PHI", 22: "ARI", 23: "PIT", 24: "LAC", 25: "SF",
        26: "SEA", 27: "TB", 28: "WSH", 29: "CAR", 30: "JAX", 33: "BAL", 34: "HOU"
    ]

    static func teamAbbreviation(fromProTeamID id: Int?) -> String {
        guard let id, let abbreviation = proTeamAbbreviations[id] else { return "FA" }
        return abbreviation
    }

    // MARK: - Injury status

    static func injuryStatus(from raw: String?) -> InjuryStatus {
        guard let raw = raw?.uppercased() else { return .active }
        switch raw {
        case "ACTIVE", "NORMAL": return .active
        case "PROBABLE": return .probable
        case "QUESTIONABLE", "DAY_TO_DAY": return .questionable
        case "DOUBTFUL": return .doubtful
        case "OUT": return .out
        case "INJURY_RESERVE", "IR": return .injuredReserve
        case "SUSPENSION", "SUSPENDED": return .suspended
        case "PHYSICALLY_UNABLE_TO_PERFORM", "PUP": return .physicallyUnableToPerform
        default: return .active
        }
    }

    // MARK: - Stats

    /// ESPN stat IDs used by the scoring mapper.
    enum StatID {
        static let passingYards = 3
        static let passingTouchdowns = 4
        static let interceptions = 20
        static let rushingYards = 24
        static let rushingTouchdowns = 25
        static let receptions = 53
        static let receivingYards = 42
        static let receivingTouchdowns = 43
        static let fumblesLost = 72
        static let twoPointConversions = 19
        static let targets = 58
        static let rushingAttempts = 23
        static let offensiveSnaps = 209
    }

    /// Builds `ScoringSettings` from ESPN's scoring item list.
    ///
    /// ESPN expresses yardage as points-per-yard, so the app's
    /// "yards per point" fields are the reciprocal. A zero or missing entry falls
    /// back to the conventional default rather than to zero, because a league that
    /// genuinely scores nothing for passing yards is far rarer than a payload that
    /// simply omitted the row.
    static func scoringSettings(from dto: ESPNDTO.ScoringSettingsDTO?) -> ScoringSettings {
        var settings = ScoringSettings.standard
        guard let items = dto?.scoringItems, !items.isEmpty else {
            // Without the item list, ESPN's scoringType is the only hint available.
            if dto?.scoringType == 1 { return .ppr }
            return .standard
        }

        var points: [Int: Double] = [:]
        var tightEndReception: Double?
        for item in items {
            guard let statId = item.statId else { continue }
            points[statId] = item.points ?? 0
            if statId == StatID.receptions, let overrides = item.pointsOverrides {
                // Key "6" is ESPN's tight end position in the override map.
                tightEndReception = overrides["6"]
            }
        }

        if let perYard = points[StatID.passingYards], perYard > 0 {
            settings.passingYardsPerPoint = 1 / perYard
        }
        if let value = points[StatID.passingTouchdowns] { settings.passingTouchdown = value }
        if let value = points[StatID.interceptions] { settings.interception = value }
        if let perYard = points[StatID.rushingYards], perYard > 0 {
            settings.rushingYardsPerPoint = 1 / perYard
        }
        if let value = points[StatID.rushingTouchdowns] { settings.rushingTouchdown = value }
        if let perYard = points[StatID.receivingYards], perYard > 0 {
            settings.receivingYardsPerPoint = 1 / perYard
        }
        if let value = points[StatID.receivingTouchdowns] { settings.receivingTouchdown = value }
        if let value = points[StatID.receptions] { settings.pointsPerReception = value }
        if let value = points[StatID.fumblesLost] { settings.fumbleLost = value }
        if let value = points[StatID.twoPointConversions] { settings.twoPointConversion = value }

        if let tightEndReception {
            settings.tightEndReceptionBonus = max(0, tightEndReception - settings.pointsPerReception)
        }

        return settings
    }

    /// Builds the starting lineup from ESPN's slot counts.
    static func startingSlots(from dto: ESPNDTO.RosterSettingsDTO?) -> (starting: [RosterSlot: Int], bench: Int, ir: Int) {
        guard let counts = dto?.lineupSlotCounts, !counts.isEmpty else {
            return (League.standardStartingSlots, 6, 1)
        }

        var starting: [RosterSlot: Int] = [:]
        var bench = 0
        var injuredReserve = 0

        for (key, count) in counts {
            guard count > 0, let id = Int(key) else { continue }
            switch id {
            case 20: bench += count
            case 21: injuredReserve += count
            default:
                guard let slot = slot(fromLineupSlotID: id), slot.isStarting else { continue }
                starting[slot, default: 0] += count
            }
        }

        if starting.isEmpty { starting = League.standardStartingSlots }
        return (starting, max(0, bench), max(0, injuredReserve))
    }

    static func acquisitionType(from raw: String?) -> AcquisitionType {
        switch raw?.uppercased() {
        case "DRAFT": return .draft
        case "WAIVER": return .waiver
        case "ADD", "FREEAGENT": return .freeAgent
        case "TRADE": return .trade
        default: return .unknown
        }
    }
}
