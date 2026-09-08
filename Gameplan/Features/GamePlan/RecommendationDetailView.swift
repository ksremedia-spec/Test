import SwiftUI

/// The full case for one recommendation.
///
/// It is structured around the five questions the product must answer for every
/// piece of advice: what, why, how much it matters, when, and what could change
/// it. Those are literal section headings rather than an implied structure,
/// because a user who does not trust the advice needs to be able to audit it.
struct RecommendationDetailView: View {
    var move: Recommendation
    var players: [PlayerID: AnalyzedPlayer]
    var onOpenPlayer: (PlayerID) -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.section) {
                header

                if !move.factors.isEmpty {
                    VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
                        SectionHeader("Why")
                        EvidenceList(factors: move.factors)
                    }
                }

                VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
                    SectionHeader("How much it matters")
                    impact
                }

                if move.deadline != nil || move.deadlineDescription != nil {
                    VStack(alignment: .leading, spacing: Theme.Spacing.small) {
                        SectionHeader("When")
                        Text(move.deadlineDescription ?? "Before kickoff")
                            .font(Theme.Typography.body)
                    }
                }

                if move.risk != nil || move.watchFor != nil {
                    VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
                        SectionHeader("What could change it")
                        VStack(alignment: .leading, spacing: Theme.Spacing.small) {
                            if let risk = move.risk {
                                Label {
                                    Text(risk).font(Theme.Typography.body)
                                } icon: {
                                    Image(systemName: "exclamationmark.triangle")
                                        .foregroundStyle(Theme.Palette.priority(.stronglyConsider))
                                }
                            }
                            if let watchFor = move.watchFor {
                                Label {
                                    Text(watchFor).font(Theme.Typography.body)
                                } icon: {
                                    Image(systemName: "eye")
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }

                if !relatedPlayers.isEmpty {
                    VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
                        SectionHeader("Players involved")
                        VStack(spacing: Theme.Spacing.medium) {
                            ForEach(relatedPlayers) { player in
                                Button {
                                    onOpenPlayer(player.id)
                                } label: {
                                    HStack {
                                        PlayerRow(player: player, accessory: .projectionWithRange)
                                        Image(systemName: "chevron.right")
                                            .font(.system(size: 11, weight: .semibold))
                                            .foregroundStyle(.tertiary)
                                    }
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
            }
            .screenPadding()
            .padding(.vertical, Theme.Spacing.large)
        }
        .background(Theme.Palette.background)
        .navigationTitle(move.category.displayName)
        .navigationBarTitleDisplayMode(.inline)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.small) {
            PriorityBadge(priority: move.priority)
            Text(move.title)
                .font(Theme.Typography.hero)
                .fixedSize(horizontal: false, vertical: true)
            Text(move.summary)
                .font(Theme.Typography.body)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var impact: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.small) {
            if let delta = move.winProbabilityDelta, abs(delta) >= 0.001 {
                HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.small) {
                    Text(String(format: "%+.1f", delta * 100))
                        .font(Theme.Typography.metric(.title))
                        .foregroundStyle(delta >= 0 ? Theme.Palette.positive : Theme.Palette.negative)
                    Text("percentage points of win probability")
                        .font(Theme.Typography.caption)
                        .foregroundStyle(.secondary)
                }
                Text("Calculated by comparing your lineup's projected distribution against your opponent's, with and without this move.")
                    .font(Theme.Typography.micro)
                    .foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text(move.priority.displayName)
                    .font(Theme.Typography.metric(.title3))
            }

            HStack(spacing: Theme.Spacing.small) {
                Pill(move.confidence.displayName, systemImage: confidenceSymbol)
                Pill(move.category.displayName)
            }
            .padding(.top, Theme.Spacing.tight)
        }
    }

    private var confidenceSymbol: String {
        switch move.confidence {
        case .high: return "checkmark.seal"
        case .medium: return "seal"
        case .low: return "questionmark.circle"
        }
    }

    private var relatedPlayers: [AnalyzedPlayer] {
        move.action.playerIDs.compactMap { players[$0] }
    }
}
