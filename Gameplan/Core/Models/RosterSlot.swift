import Foundation

/// A lineup slot as configured by the league.
enum RosterSlot: String, Codable, CaseIterable, Hashable, Sendable {
    case quarterback = "QB"
    case runningBack = "RB"
    case wideReceiver = "WR"
    case tightEnd = "TE"
    case flex = "FLEX"
    case superflex = "SUPERFLEX"
    case wrTeFlex = "WR/TE"
    case kicker = "K"
    case defense = "DST"
    case bench = "BN"
    case injuredReserve = "IR"

    /// Positions that may legally occupy this slot.
    var eligiblePositions: Set<Position> {
        switch self {
        case .quarterback: return [.quarterback]
        case .runningBack: return [.runningBack]
        case .wideReceiver: return [.wideReceiver]
        case .tightEnd: return [.tightEnd]
        case .flex: return [.runningBack, .wideReceiver, .tightEnd]
        case .superflex: return [.quarterback, .runningBack, .wideReceiver, .tightEnd]
        case .wrTeFlex: return [.wideReceiver, .tightEnd]
        case .kicker: return [.kicker]
        case .defense: return [.defense]
        case .bench, .injuredReserve: return Set(Position.allCases)
        }
    }

    /// Slots that actually score points in a given week.
    var isStarting: Bool {
        self != .bench && self != .injuredReserve
    }

    /// Fewer eligible positions means the slot is harder to fill, so the optimizer
    /// fills the most constrained slots first.
    var flexibility: Int { eligiblePositions.count }

    var displayName: String {
        switch self {
        case .superflex: return "SFLEX"
        case .injuredReserve: return "IR"
        default: return rawValue
        }
    }

    var displayOrder: Int {
        switch self {
        case .quarterback: return 0
        case .runningBack: return 1
        case .wideReceiver: return 2
        case .tightEnd: return 3
        case .wrTeFlex: return 4
        case .flex: return 5
        case .superflex: return 6
        case .defense: return 7
        case .kicker: return 8
        case .bench: return 9
        case .injuredReserve: return 10
        }
    }

    func accepts(_ position: Position) -> Bool {
        eligiblePositions.contains(position)
    }
}
