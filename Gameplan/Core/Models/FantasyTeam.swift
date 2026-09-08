import Foundation

/// How a player arrived on the roster.
enum AcquisitionType: String, Codable, Sendable {
    case draft
    case waiver
    case freeAgent
    case trade
    case unknown
}

/// One player on one roster, in the slot the manager currently has them in.
struct RosterEntry: Codable, Hashable, Identifiable, Sendable {
    var context: PlayerContext
    var slot: RosterSlot
    var acquisition: AcquisitionType

    var id: PlayerID { context.id }
    var player: Player { context.player }

    init(context: PlayerContext, slot: RosterSlot, acquisition: AcquisitionType = .unknown) {
        self.context = context
        self.slot = slot
        self.acquisition = acquisition
    }
}

/// A team in the league — the user's or an opponent's.
struct FantasyTeam: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var name: String
    var ownerName: String?
    var abbreviation: String?
    var wins: Int
    var losses: Int
    var ties: Int
    var pointsFor: Double
    var pointsAgainst: Double
    var standing: Int?
    var roster: [RosterEntry]
    /// Remaining FAAB dollars, when the league uses FAAB.
    var faabRemaining: Int?
    var waiverPriority: Int?

    init(
        id: String,
        name: String,
        ownerName: String? = nil,
        abbreviation: String? = nil,
        wins: Int = 0,
        losses: Int = 0,
        ties: Int = 0,
        pointsFor: Double = 0,
        pointsAgainst: Double = 0,
        standing: Int? = nil,
        roster: [RosterEntry] = [],
        faabRemaining: Int? = nil,
        waiverPriority: Int? = nil
    ) {
        self.id = id
        self.name = name
        self.ownerName = ownerName
        self.abbreviation = abbreviation
        self.wins = wins
        self.losses = losses
        self.ties = ties
        self.pointsFor = pointsFor
        self.pointsAgainst = pointsAgainst
        self.standing = standing
        self.roster = roster
        self.faabRemaining = faabRemaining
        self.waiverPriority = waiverPriority
    }

    var recordLabel: String {
        ties > 0 ? "\(wins)-\(losses)-\(ties)" : "\(wins)-\(losses)"
    }

    var starters: [RosterEntry] { roster.filter { $0.slot.isStarting } }
    var bench: [RosterEntry] { roster.filter { $0.slot == .bench } }
    var injuredReserve: [RosterEntry] { roster.filter { $0.slot == .injuredReserve } }

    /// Everyone who could legally be started this week (bench included, IR excluded).
    var availableForLineup: [RosterEntry] { roster.filter { $0.slot != .injuredReserve } }

    func entry(for id: PlayerID) -> RosterEntry? {
        roster.first { $0.id == id }
    }

    func players(at position: Position) -> [RosterEntry] {
        roster.filter { $0.player.position == position }
    }
}
