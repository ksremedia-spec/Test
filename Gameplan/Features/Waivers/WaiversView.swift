import SwiftUI

/// Waiver recommendations, ranked for this roster.
///
/// Not a browsable list of free agents — a short, ordered set of moves with the
/// reasoning, the player to drop, and a suggested bid. If the user wants to
/// browse, ESPN already does that well.
@MainActor
struct WaiversView: View {
    @Environment(AppModel.self) private var model
    @State private var selectedCandidate: WaiverCandidate?
    @State private var selectedPlayerID: PlayerID?

    var body: some View {
        NavigationStack {
            Group {
                if let analysis = model.analysis {
                    content(analysis: analysis)
                } else if model.loadState.isLoading {
                    ScrollView { SkeletonRows(count: 5).screenPadding().padding(.top, Theme.Spacing.large) }
                } else if let error = model.loadState.error {
                    ErrorStateView(error: error, onRetry: { model.load(force: true) }, onUseDemo: { model.switchToDemo() })
                } else {
                    EmptyStateView(
                        title: "No waiver data",
                        message: "Connect a league to see who's worth adding.",
                        systemImage: "arrow.triangle.2.circlepath",
                        actionTitle: nil,
                        action: nil
                    )
                }
            }
            .background(Theme.Palette.background)
            .navigationTitle("Waivers")
            .navigationDestination(item: $selectedCandidate) { candidate in
                WaiverDetailView(
                    candidate: candidate,
                    league: model.league,
                    onOpenPlayer: { selectedPlayerID = $0 }
                )
            }
            .navigationDestination(item: $selectedPlayerID) { id in
                if let player = model.analyzedPlayer(for: id) {
                    PlayerDetailView(player: player, plan: model.plan)
                }
            }
        }
    }

    @ViewBuilder
    private func content(analysis: WeeklyAnalysis) -> some View {
        if analysis.waiverCandidates.isEmpty {
            EmptyStateView(
                title: "Nothing worth adding",
                message: "Gameplan checked every available player against your roster and none of them improve it. That's a good sign — your bench is stronger than the wire.",
                systemImage: "checkmark.circle",
                actionTitle: "Check again",
                action: { model.load(force: true) }
            )
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.section) {
                    budgetHeader(analysis: analysis)

                    VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
                        SectionHeader("Waiver priorities", detail: "\(analysis.waiverCandidates.count)")
                        VStack(spacing: Theme.Spacing.medium) {
                            ForEach(Array(analysis.waiverCandidates.enumerated()), id: \.element.id) { index, candidate in
                                Button { selectedCandidate = candidate } label: {
                                    WaiverCard(candidate: candidate, rank: index + 1)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }

                    Text("Suggested bids are Gameplan's recommendations based on how much the player improves your roster. They aren't market prices — nobody can see what your leaguemates will bid.")
                        .font(Theme.Typography.micro)
                        .foregroundStyle(.tertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .screenPadding()
                .padding(.vertical, Theme.Spacing.large)
            }
            .refreshable { await model.refresh() }
        }
    }

    @ViewBuilder
    private func budgetHeader(analysis: WeeklyAnalysis) -> some View {
        if let team = model.snapshot?.matchup.userTeam, let league = model.league {
            HStack(spacing: Theme.Spacing.large) {
                if let faab = team.faabRemaining {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("$\(faab)")
                            .font(Theme.Typography.metric(.title))
                        Text("FAAB left")
                            .font(Theme.Typography.micro)
                            .foregroundStyle(.tertiary)
                    }
                } else if let priority = team.waiverPriority {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("#\(priority)")
                            .font(Theme.Typography.metric(.title))
                        Text("Waiver priority")
                            .font(Theme.Typography.micro)
                            .foregroundStyle(.tertiary)
                    }
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(league.waivers.displayName)
                        .font(Theme.Typography.rowTitle)
                    Text(league.settingsSummary)
                        .font(Theme.Typography.micro)
                        .foregroundStyle(.tertiary)
                }
                Spacer()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .surfaceCard()
            .accessibilityElement(children: .combine)
        }
    }
}

/// The summary card for one waiver recommendation.
struct WaiverCard: View {
    var candidate: WaiverCandidate
    var rank: Int

    private var priority: RecommendationPriority {
        switch candidate.score {
        case 0.55...: return .mustDo
        case 0.30..<0.55: return .stronglyConsider
        default: return .monitor
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.small) {
            HStack(spacing: Theme.Spacing.small) {
                Text("\(rank)")
                    .font(Theme.Typography.metric(.footnote))
                    .foregroundStyle(.tertiary)
                PriorityBadge(priority: priority)
                Spacer()
                if let range = candidate.faabRange {
                    Pill("$\(range.lowerBound)–$\(range.upperBound)", systemImage: "dollarsign")
                }
            }

            Text(candidate.player.player.fullName)
                .font(Theme.Typography.title)

            Text(subtitle)
                .font(Theme.Typography.caption)
                .foregroundStyle(.secondary)

            if candidate.immediateUpgrade > 0.5 {
                Label(
                    String(format: "Adds about %.1f points to your lineup this week", candidate.immediateUpgrade),
                    systemImage: "arrow.up.right"
                )
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Palette.positive)
            }

            if let drop = candidate.suggestedDrop {
                Label("Drop \(drop.player.fullName)", systemImage: "minus.circle")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .surfaceCard()
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Priority \(rank), \(candidate.player.player.fullName). \(subtitle)")
    }

    private var subtitle: String {
        var parts = [
            "\(candidate.player.position.abbreviation) · \(candidate.player.player.teamAbbreviation)",
            "\(candidate.player.projection.mean.pointsLabel) projected"
        ]
        if let owned = candidate.player.player.rosteredPercentage {
            parts.append("\(owned.percentLabel) rostered")
        }
        return parts.joined(separator: "  ·  ")
    }
}

/// The full case for one waiver add.
struct WaiverDetailView: View {
    var candidate: WaiverCandidate
    var league: League? = nil
    var onOpenPlayer: (PlayerID) -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.section) {
                VStack(alignment: .leading, spacing: Theme.Spacing.small) {
                    Text(candidate.player.player.fullName)
                        .font(Theme.Typography.hero)
                    Text("\(candidate.player.position.displayName) · \(candidate.player.player.team.fullName)")
                        .font(Theme.Typography.caption)
                        .foregroundStyle(.secondary)
                }

                VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
                    SectionHeader("Why add him")
                    EvidenceList(factors: candidate.factors)
                }

                if let drop = candidate.suggestedDrop {
                    VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
                        SectionHeader("Who to drop")
                        Button { onOpenPlayer(drop.id) } label: {
                            VStack(alignment: .leading, spacing: Theme.Spacing.tight) {
                                PlayerRow(player: drop, accessory: .projection)
                                Text(dropReason(drop))
                                    .font(Theme.Typography.caption)
                                    .foregroundStyle(.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .surfaceCard()
                        }
                        .buttonStyle(.plain)
                    }
                }

                if let range = candidate.faabRange {
                    VStack(alignment: .leading, spacing: Theme.Spacing.small) {
                        SectionHeader("Suggested bid")
                        Text("$\(range.lowerBound) – $\(range.upperBound)")
                            .font(Theme.Typography.metric(.title))
                        Text("A recommendation based on how much he improves your roster and how much budget you have left. It is not a market price.")
                            .font(Theme.Typography.micro)
                            .foregroundStyle(.tertiary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
                    SectionHeader("Outlook")
                    VStack(alignment: .leading, spacing: Theme.Spacing.small) {
                        outlookRow(
                            "This week",
                            candidate.immediateUpgrade > 0.5
                                ? String(format: "Starts for you and adds about %.1f points", candidate.immediateUpgrade)
                                : "Wouldn't crack your lineup yet"
                        )
                        outlookRow(
                            "Rest of season",
                            candidate.restOfSeasonValue > 3
                                ? String(format: "Roughly %.1f points a week above the next free agent at his position", candidate.restOfSeasonValue)
                                : "Marginal — he's a depth piece rather than an upgrade"
                        )
                        if let league {
                            outlookRow("League context", "\(league.teamCount)-team \(league.scoring.formatName)")
                        }
                    }
                    .surfaceCard()
                }

                Button { onOpenPlayer(candidate.id) } label: {
                    Label("See full player detail", systemImage: "person.text.rectangle")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }
            .screenPadding()
            .padding(.vertical, Theme.Spacing.large)
        }
        .background(Theme.Palette.background)
        .navigationTitle("Add")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func outlookRow(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(Theme.Typography.micro)
                .foregroundStyle(.tertiary)
            Text(value)
                .font(Theme.Typography.body)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private func dropReason(_ drop: AnalyzedPlayer) -> String {
        if drop.player.injury.status == .injuredReserve {
            return "He's on injured reserve and isn't helping you this week."
        }
        if drop.trend == .falling {
            return "His role has been shrinking and there's better value available."
        }
        return "He's the lowest-value spot on your roster right now."
    }
}
