import Foundation

/// A football position that can score fantasy points.
enum Position: String, Codable, CaseIterable, Hashable, Sendable {
    case quarterback = "QB"
    case runningBack = "RB"
    case wideReceiver = "WR"
    case tightEnd = "TE"
    case kicker = "K"
    case defense = "DST"

    var abbreviation: String { rawValue }

    var displayName: String {
        switch self {
        case .quarterback: return "Quarterback"
        case .runningBack: return "Running Back"
        case .wideReceiver: return "Wide Receiver"
        case .tightEnd: return "Tight End"
        case .kicker: return "Kicker"
        case .defense: return "Defense / Special Teams"
        }
    }

    /// Positions whose value is driven by receiving volume. Used by scoring-format
    /// aware analysis (PPR inflates these, standard scoring does not).
    var isReceivingDriven: Bool {
        self == .wideReceiver || self == .tightEnd || self == .runningBack
    }

    /// Rough week-to-week coefficient of variation for a position, derived from the
    /// general shape of fantasy scoring distributions. Used to model floor/ceiling
    /// when a data source only supplies a mean projection.
    ///
    /// These are *model parameters*, not measured league statistics, and every
    /// recommendation built on them is labelled `.derived` for the user.
    var baselineVariation: Double {
        switch self {
        case .quarterback: return 0.34
        case .runningBack: return 0.52
        case .wideReceiver: return 0.58
        case .tightEnd: return 0.62
        case .kicker: return 0.55
        case .defense: return 0.70
        }
    }

    /// Sort order used everywhere a roster is displayed.
    var displayOrder: Int {
        switch self {
        case .quarterback: return 0
        case .runningBack: return 1
        case .wideReceiver: return 2
        case .tightEnd: return 3
        case .kicker: return 4
        case .defense: return 5
        }
    }
}
