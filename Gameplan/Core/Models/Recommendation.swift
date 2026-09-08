import Foundation

/// How urgently the user should act. Deliberately only four levels — more would
/// dilute the signal the app exists to provide.
enum RecommendationPriority: String, Codable, CaseIterable, Comparable, Sendable {
    case mustDo
    case stronglyConsider
    case monitor
    case noAction

    var displayName: String {
        switch self {
        case .mustDo: return "Must do"
        case .stronglyConsider: return "Strongly consider"
        case .monitor: return "Monitor"
        case .noAction: return "No action"
        }
    }

    var headerName: String {
        switch self {
        case .mustDo: return "MUST DO"
        case .stronglyConsider: return "STRONGLY CONSIDER"
        case .monitor: return "MONITOR"
        case .noAction: return "NO ACTION NEEDED"
        }
    }

    var sortOrder: Int {
        switch self {
        case .mustDo: return 0
        case .stronglyConsider: return 1
        case .monitor: return 2
        case .noAction: return 3
        }
    }

    static func < (lhs: RecommendationPriority, rhs: RecommendationPriority) -> Bool {
        lhs.sortOrder < rhs.sortOrder
    }
}

/// How much the app trusts its own recommendation.
enum ConfidenceLevel: String, Codable, CaseIterable, Sendable {
    case high
    case medium
    case low

    var displayName: String {
        switch self {
        case .high: return "High confidence"
        case .medium: return "Medium confidence"
        case .low: return "Low confidence"
        }
    }

    static func from(score: Double) -> ConfidenceLevel {
        switch score {
        case 0.72...: return .high
        case 0.45..<0.72: return .medium
        default: return .low
        }
    }
}

/// The concrete thing the user is being asked to do.
enum RecommendationAction: Codable, Hashable, Sendable {
    case start(PlayerID)
    case bench(PlayerID)
    /// Bring `promote` into `slot`, sending `demote` to the bench.
    case swap(promote: PlayerID, demote: PlayerID, slot: RosterSlot)
    case moveToSlot(PlayerID, slot: RosterSlot)
    case add(PlayerID, drop: PlayerID?)
    case drop(PlayerID)
    case exploreTrade(give: [PlayerID], targetPosition: Position)
    case monitor(PlayerID)
    case none

    var verb: String {
        switch self {
        case .start: return "Start"
        case .bench: return "Bench"
        case .swap: return "Swap"
        case .moveToSlot: return "Move"
        case .add: return "Add"
        case .drop: return "Drop"
        case .exploreTrade: return "Trade"
        case .monitor: return "Monitor"
        case .none: return "Hold"
        }
    }

    var symbolName: String {
        switch self {
        case .start: return "checkmark.circle.fill"
        case .bench: return "minus.circle.fill"
        case .swap: return "arrow.left.arrow.right.circle.fill"
        case .moveToSlot: return "arrow.up.arrow.down.circle.fill"
        case .add: return "plus.circle.fill"
        case .drop: return "trash.circle.fill"
        case .exploreTrade: return "arrow.triangle.swap"
        case .monitor: return "eye.circle.fill"
        case .none: return "hand.thumbsup.circle.fill"
        }
    }

    /// Players this action refers to, for linking rows to detail screens.
    var playerIDs: [PlayerID] {
        switch self {
        case .start(let id), .bench(let id), .drop(let id), .monitor(let id):
            return [id]
        case .moveToSlot(let id, _):
            return [id]
        case .swap(let promote, let demote, _):
            return [promote, demote]
        case .add(let id, let drop):
            return [id] + (drop.map { [$0] } ?? [])
        case .exploreTrade(let give, _):
            return give
        case .none:
            return []
        }
    }
}

/// A single supporting piece of evidence behind a recommendation.
///
/// The `evidence` field is what keeps the app honest: the UI always shows whether
/// a factor is a measured fact, an app calculation, or a model estimate.
struct RecommendationFactor: Codable, Hashable, Identifiable, Sendable {
    enum Direction: String, Codable, Sendable {
        case supporting
        case opposing
        case neutral

        var symbolName: String {
            switch self {
            case .supporting: return "plus"
            case .opposing: return "minus"
            case .neutral: return "circle"
            }
        }
    }

    var id: String
    var summary: String
    var detail: String?
    var direction: Direction
    var evidence: EvidenceLevel

    init(
        id: String = UUID().uuidString,
        summary: String,
        detail: String? = nil,
        direction: Direction = .supporting,
        evidence: EvidenceLevel = .derived
    ) {
        self.id = id
        self.summary = summary
        self.detail = detail
        self.direction = direction
        self.evidence = evidence
    }
}

/// A complete, explainable recommendation.
///
/// Every field maps to one of the five questions the product must answer:
/// what (`title`/`action`), why (`factors`/`reasoning`), how much it matters
/// (`priority`/`winProbabilityDelta`), when (`deadline`), and what could change it
/// (`risk`/`watchFor`).
struct Recommendation: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var action: RecommendationAction
    var title: String
    var summary: String
    var priority: RecommendationPriority
    var confidence: ConfidenceLevel
    var confidenceScore: Double
    var factors: [RecommendationFactor]
    /// Change in this week's win probability if the user follows the advice.
    /// Expressed as a fraction, so 0.032 is +3.2 percentage points.
    var winProbabilityDelta: Double?
    var risk: String?
    var watchFor: String?
    var deadline: Date?
    var deadlineDescription: String?
    var category: Category

    enum Category: String, Codable, CaseIterable, Sendable {
        case lineup
        case waiver
        case trade
        case roster
        case watch

        var displayName: String {
            switch self {
            case .lineup: return "Lineup"
            case .waiver: return "Waivers"
            case .trade: return "Trade"
            case .roster: return "Roster"
            case .watch: return "Watch"
            }
        }
    }

    init(
        id: String = UUID().uuidString,
        action: RecommendationAction,
        title: String,
        summary: String,
        priority: RecommendationPriority,
        confidenceScore: Double,
        factors: [RecommendationFactor] = [],
        winProbabilityDelta: Double? = nil,
        risk: String? = nil,
        watchFor: String? = nil,
        deadline: Date? = nil,
        deadlineDescription: String? = nil,
        category: Category
    ) {
        self.id = id
        self.action = action
        self.title = title
        self.summary = summary
        self.priority = priority
        self.confidenceScore = min(1, max(0, confidenceScore))
        self.confidence = ConfidenceLevel.from(score: confidenceScore)
        self.factors = factors
        self.winProbabilityDelta = winProbabilityDelta
        self.risk = risk
        self.watchFor = watchFor
        self.deadline = deadline
        self.deadlineDescription = deadlineDescription
        self.category = category
    }

    var supportingFactors: [RecommendationFactor] { factors.filter { $0.direction == .supporting } }
    var opposingFactors: [RecommendationFactor] { factors.filter { $0.direction == .opposing } }

    /// "+3.2% win probability", or nil when the move is not lineup-affecting.
    var winProbabilityLabel: String? {
        guard let delta = winProbabilityDelta, abs(delta) >= 0.001 else { return nil }
        let percentage = delta * 100
        return String(format: "%+.1f%% win probability", percentage)
    }
}
