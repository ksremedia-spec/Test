import Foundation

/// Official game-status designation for a player.
enum InjuryStatus: String, Codable, CaseIterable, Hashable, Sendable {
    case active = "ACTIVE"
    case probable = "PROBABLE"
    case questionable = "QUESTIONABLE"
    case doubtful = "DOUBTFUL"
    case out = "OUT"
    case injuredReserve = "IR"
    case suspended = "SUSPENDED"
    case physicallyUnableToPerform = "PUP"

    var displayName: String {
        switch self {
        case .active: return "Active"
        case .probable: return "Probable"
        case .questionable: return "Questionable"
        case .doubtful: return "Doubtful"
        case .out: return "Out"
        case .injuredReserve: return "Injured Reserve"
        case .suspended: return "Suspended"
        case .physicallyUnableToPerform: return "PUP"
        }
    }

    var shortLabel: String {
        switch self {
        case .active: return ""
        case .probable: return "P"
        case .questionable: return "Q"
        case .doubtful: return "D"
        case .out: return "OUT"
        case .injuredReserve: return "IR"
        case .suspended: return "SUS"
        case .physicallyUnableToPerform: return "PUP"
        }
    }

    /// Probability the player takes the field at all. Used to discount projections
    /// and to widen the uncertainty band. Model parameter, not measured data.
    var playProbability: Double {
        switch self {
        case .active: return 1.0
        case .probable: return 0.95
        case .questionable: return 0.70
        case .doubtful: return 0.25
        case .out, .injuredReserve, .suspended, .physicallyUnableToPerform: return 0.0
        }
    }

    /// True when the status is unresolved close to kickoff and therefore worth
    /// putting on the user's watch list.
    var isUncertain: Bool {
        self == .questionable || self == .doubtful
    }

    var isUnavailable: Bool { playProbability == 0 }

    /// How much extra week-to-week variance the designation adds.
    var varianceMultiplier: Double {
        switch self {
        case .active: return 1.0
        case .probable: return 1.05
        case .questionable: return 1.25
        case .doubtful: return 1.45
        case .out, .injuredReserve, .suspended, .physicallyUnableToPerform: return 1.0
        }
    }
}

/// Midweek practice participation. A questionable player who practiced fully is a
/// very different proposition from one who did not practice at all, and this is
/// one of the highest-signal, lowest-cost inputs available.
enum PracticeParticipation: String, Codable, CaseIterable, Hashable, Sendable {
    case full = "FULL"
    case limited = "LIMITED"
    case didNotParticipate = "DNP"

    var displayName: String {
        switch self {
        case .full: return "Full practice"
        case .limited: return "Limited practice"
        case .didNotParticipate: return "Did not practice"
        }
    }

    /// Multiplier applied on top of `InjuryStatus.playProbability`.
    var playProbabilityAdjustment: Double {
        switch self {
        case .full: return 1.25
        case .limited: return 1.0
        case .didNotParticipate: return 0.55
        }
    }
}

/// Everything known about a player's availability for the upcoming game.
struct InjuryReport: Codable, Hashable, Sendable {
    var status: InjuryStatus
    var designation: String?
    var practice: PracticeParticipation?
    var note: String?
    var updatedAt: Date?

    init(
        status: InjuryStatus = .active,
        designation: String? = nil,
        practice: PracticeParticipation? = nil,
        note: String? = nil,
        updatedAt: Date? = nil
    ) {
        self.status = status
        self.designation = designation
        self.practice = practice
        self.note = note
        self.updatedAt = updatedAt
    }

    static let healthy = InjuryReport()

    /// Blended probability the player suits up, clamped to a sane range.
    var effectivePlayProbability: Double {
        guard status.playProbability > 0 else { return 0 }
        let adjustment = practice?.playProbabilityAdjustment ?? 1.0
        return min(1.0, max(0.05, status.playProbability * adjustment))
    }

    var requiresMonitoring: Bool {
        status.isUncertain || (status == .active && practice == .didNotParticipate)
    }

    /// One-line summary suitable for a watch-list row.
    var summary: String {
        var parts: [String] = []
        if status != .active { parts.append(status.displayName) }
        if let practice { parts.append(practice.displayName) }
        if parts.isEmpty { return "Healthy" }
        return parts.joined(separator: " · ")
    }
}
