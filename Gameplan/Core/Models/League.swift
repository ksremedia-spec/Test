import Foundation

/// How players move from the free-agent pool onto rosters.
enum WaiverSystem: Codable, Hashable, Sendable {
    /// Free agent acquisition budget. Bids are dollars out of a season-long pot.
    case faab(budget: Int)
    /// Continuous rolling list — claiming drops you to the back.
    case rollingPriority
    /// Waiver order resets weekly by reverse standings.
    case reverseStandings
    /// No waivers at all — first come, first served.
    case freeAgency

    var displayName: String {
        switch self {
        case .faab(let budget): return "FAAB ($\(budget))"
        case .rollingPriority: return "Rolling waiver priority"
        case .reverseStandings: return "Reverse standings"
        case .freeAgency: return "Free agency"
        }
    }

    var usesFAAB: Bool {
        if case .faab = self { return true }
        return false
    }

    var faabBudget: Int? {
        if case .faab(let budget) = self { return budget }
        return nil
    }
}

/// Whether the league carries players over between seasons.
enum LeagueContinuity: String, Codable, CaseIterable, Sendable {
    case redraft
    case keeper
    case dynasty

    var displayName: String {
        switch self {
        case .redraft: return "Redraft"
        case .keeper: return "Keeper"
        case .dynasty: return "Dynasty"
        }
    }

    /// How much weight rest-of-season and future value should carry relative to
    /// winning the current week.
    var futureValueWeight: Double {
        switch self {
        case .redraft: return 0.25
        case .keeper: return 0.45
        case .dynasty: return 0.70
        }
    }
}

/// Which fantasy platform a league came from.
enum FantasyPlatform: String, Codable, CaseIterable, Sendable {
    case espn
    case demo

    var displayName: String {
        switch self {
        case .espn: return "ESPN Fantasy"
        case .demo: return "Demo League"
        }
    }
}

/// League configuration. Almost every recommendation is a function of this plus
/// the roster, so it is threaded through the whole engine rather than read from a
/// global.
struct League: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var platform: FantasyPlatform
    var name: String
    var season: Int
    var teamCount: Int
    var scoring: ScoringSettings
    /// Starting lineup composition, e.g. [.quarterback: 1, .runningBack: 2, ...].
    var startingSlots: [RosterSlot: Int]
    var benchSlots: Int
    var injuredReserveSlots: Int
    var waivers: WaiverSystem
    var waiverProcessingDay: Int?
    var continuity: LeagueContinuity
    var playoffTeamCount: Int
    var playoffStartWeek: Int
    var regularSeasonWeeks: Int
    var tradeDeadlineWeek: Int?
    var isPublic: Bool

    init(
        id: String,
        platform: FantasyPlatform,
        name: String,
        season: Int,
        teamCount: Int = 12,
        scoring: ScoringSettings = .ppr,
        startingSlots: [RosterSlot: Int] = League.standardStartingSlots,
        benchSlots: Int = 6,
        injuredReserveSlots: Int = 1,
        waivers: WaiverSystem = .faab(budget: 100),
        waiverProcessingDay: Int? = 4,
        continuity: LeagueContinuity = .redraft,
        playoffTeamCount: Int = 6,
        playoffStartWeek: Int = 15,
        regularSeasonWeeks: Int = 14,
        tradeDeadlineWeek: Int? = 12,
        isPublic: Bool = false
    ) {
        self.id = id
        self.platform = platform
        self.name = name
        self.season = season
        self.teamCount = teamCount
        self.scoring = scoring
        self.startingSlots = startingSlots
        self.benchSlots = benchSlots
        self.injuredReserveSlots = injuredReserveSlots
        self.waivers = waivers
        self.waiverProcessingDay = waiverProcessingDay
        self.continuity = continuity
        self.playoffTeamCount = playoffTeamCount
        self.playoffStartWeek = playoffStartWeek
        self.regularSeasonWeeks = regularSeasonWeeks
        self.tradeDeadlineWeek = tradeDeadlineWeek
        self.isPublic = isPublic
    }

    static let standardStartingSlots: [RosterSlot: Int] = [
        .quarterback: 1,
        .runningBack: 2,
        .wideReceiver: 2,
        .tightEnd: 1,
        .flex: 1,
        .defense: 1,
        .kicker: 1
    ]

    /// The lineup expanded into individual slots, most constrained first.
    var lineupSlots: [RosterSlot] {
        startingSlots
            .flatMap { slot, count in Array(repeating: slot, count: max(0, count)) }
            .sorted { lhs, rhs in
                if lhs.flexibility != rhs.flexibility { return lhs.flexibility < rhs.flexibility }
                return lhs.displayOrder < rhs.displayOrder
            }
    }

    var startingLineupSize: Int { startingSlots.values.reduce(0, +) }
    var rosterSize: Int { startingLineupSize + benchSlots }

    var isSuperflex: Bool { (startingSlots[.superflex] ?? 0) > 0 }

    /// How many players at a position the league as a whole will start each week.
    /// This is the basis for replacement level and therefore for scarcity.
    func leagueWideStarters(at position: Position) -> Int {
        var dedicated = 0
        var flexCapacity = 0
        for (slot, count) in startingSlots {
            guard slot.isStarting else { continue }
            guard slot.accepts(position) else { continue }
            if slot.eligiblePositions.count == 1 {
                dedicated += count
            } else {
                flexCapacity += count
            }
        }
        // Flex slots are shared, so allocate a fraction of them to each eligible
        // position rather than counting them in full.
        let eligibleFlexPositions = max(1, Set(
            startingSlots.keys
                .filter { $0.isStarting && $0.eligiblePositions.count > 1 }
                .flatMap { $0.eligiblePositions }
        ).count)
        let share = Double(flexCapacity) / Double(eligibleFlexPositions)
        return Int((Double(dedicated) + share).rounded()) * teamCount
    }

    /// Human-readable one-liner for settings screens.
    var settingsSummary: String {
        "\(teamCount)-team · \(scoring.formatName) · \(continuity.displayName)"
    }

    func isPlayoffWeek(_ week: Int) -> Bool { week >= playoffStartWeek }
}
