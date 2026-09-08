import SwiftUI

/// The standard compact player row: identity on the left, projection on the
/// right, one line of context between them.
///
/// Everything the eye needs is on two lines. Anything more belongs on the player
/// detail screen, not in a list.
struct PlayerRow: View {
    var player: AnalyzedPlayer
    var slot: RosterSlot? = nil
    var accessory: Accessory = .projection
    var isDimmed: Bool = false

    enum Accessory {
        case projection
        case projectionWithRange
        case hidden
    }

    var body: some View {
        HStack(alignment: .center, spacing: Theme.Spacing.medium) {
            if let slot {
                Text(slot.displayName)
                    .font(Theme.Typography.micro)
                    .foregroundStyle(slot.isStarting ? .primary : .tertiary)
                    .frame(width: 42, alignment: .leading)
            }

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: Theme.Spacing.tight) {
                    Text(player.player.fullName)
                        .font(Theme.Typography.rowTitle)
                        .lineLimit(1)
                    if !player.player.injury.status.shortLabel.isEmpty {
                        Text(player.player.injury.status.shortLabel)
                            .font(Theme.Typography.micro)
                            .foregroundStyle(injuryTint)
                    }
                }
                Text(subtitle)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer(minLength: Theme.Spacing.small)

            switch accessory {
            case .projection:
                Text(player.projection.mean.pointsLabel)
                    .font(Theme.Typography.metric(.body))
            case .projectionWithRange:
                VStack(alignment: .trailing, spacing: 1) {
                    Text(player.projection.mean.pointsLabel)
                        .font(Theme.Typography.metric(.body))
                    Text("\(player.projection.floor.pointsLabel)–\(player.projection.ceiling.pointsLabel)")
                        .font(Theme.Typography.micro)
                        .foregroundStyle(.tertiary)
                }
            case .hidden:
                EmptyView()
            }
        }
        .opacity(isDimmed ? 0.45 : 1)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
    }

    private var subtitle: String {
        var parts: [String] = ["\(player.position.abbreviation) · \(player.player.teamAbbreviation)"]
        if let environment = player.context.environment {
            parts.append(environment.opponentLabel)
        }
        if player.trend == .rising { parts.append("trending up") }
        if player.trend == .falling { parts.append("trending down") }
        return parts.joined(separator: "  ")
    }

    private var injuryTint: Color {
        switch player.player.injury.status {
        case .out, .injuredReserve, .suspended, .physicallyUnableToPerform: return Theme.Palette.negative
        case .doubtful: return Theme.Palette.negative.opacity(0.8)
        case .questionable: return Color(red: 0.90, green: 0.52, blue: 0.13)
        default: return .secondary
        }
    }

    private var accessibilityLabel: String {
        var parts: [String] = [player.player.fullName, player.position.displayName]
        if player.player.injury.status != .active {
            parts.append(player.player.injury.status.displayName)
        }
        parts.append("projected \(player.projection.mean.pointsLabel) points")
        return parts.joined(separator: ", ")
    }
}
