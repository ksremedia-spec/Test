import SwiftUI

/// This week's head-to-head, in the order a manager reads it: where do I stand,
/// where am I winning and losing, and who decides it.
@MainActor
struct MatchupView: View {
    @Environment(AppModel.self) private var model
    @State private var selectedPlayerID: PlayerID?

    var body: some View {
        NavigationStack {
            Group {
                if let analysis = model.analysis,
                   let matchup = model.snapshot?.matchup {
                    content(analysis: analysis, matchup: matchup)
                } else if model.loadState.isLoading {
                    ScrollView { SkeletonRows(count: 6).screenPadding().padding(.top, Theme.Spacing.large) }
                } else if let error = model.loadState.error {
                    ErrorStateView(error: error, onRetry: { model.load(force: true) }, onUseDemo: { model.switchToDemo() })
                } else {
                    EmptyStateView(
                        title: "No matchup yet",
                        message: "Connect a league to see who you're playing.",
                        systemImage: "person.2",
                        actionTitle: nil,
                        action: nil
                    )
                }
            }
            .background(Theme.Palette.background)
            .navigationTitle("Matchup")
            .navigationDestination(item: $selectedPlayerID) { id in
                if let player = model.analyzedPlayer(for: id) {
                    PlayerDetailView(player: player, plan: model.plan)
                }
            }
        }
    }

    @ViewBuilder
    private func content(analysis: WeeklyAnalysis, matchup: Matchup) -> some View {
        if let opponent = matchup.opponentTeam {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.section) {
                    scoreline(analysis: analysis, matchup: matchup, opponent: opponent)
                    rangeSection(analysis: analysis)
                    advantagesSection(analysis: analysis)
                    swingSection(analysis: analysis)
                    opponentLineupSection(analysis: analysis, opponent: opponent)
                }
                .screenPadding()
                .padding(.vertical, Theme.Spacing.large)
            }
            .refreshable { await model.refresh() }
        } else {
            EmptyStateView(
                title: "No opponent this week",
                message: "You don't have a head-to-head matchup in week \(analysis.plan.week). Gameplan is optimizing your lineup for total points instead.",
                systemImage: "figure.stand",
                actionTitle: nil,
                action: nil
            )
        }
    }

    private func scoreline(analysis: WeeklyAnalysis, matchup: Matchup, opponent: FantasyTeam) -> some View {
        let outlook = analysis.plan.outlook
        return VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
            HStack(alignment: .top) {
                teamColumn(name: matchup.userTeam.name, record: matchup.userTeam.recordLabel,
                           points: outlook.projectedPoints, alignment: .leading)
                Spacer(minLength: Theme.Spacing.small)
                Text("vs")
                    .font(Theme.Typography.micro)
                    .foregroundStyle(.tertiary)
                    .padding(.top, Theme.Spacing.small)
                Spacer(minLength: Theme.Spacing.small)
                teamColumn(name: opponent.name, record: opponent.recordLabel,
                           points: outlook.projectedOpponentPoints, alignment: .trailing)
            }

            WinProbabilityMeter(
                probability: outlook.winProbability,
                posture: outlook.posture,
                isEstimate: true
            )

            Text(outlook.posture.strategyStatement)
                .font(Theme.Typography.body)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .surfaceCard()
    }

    private func teamColumn(name: String, record: String, points: Double, alignment: HorizontalAlignment) -> some View {
        VStack(alignment: alignment, spacing: 2) {
            Text(name)
                .font(Theme.Typography.rowTitle)
                .lineLimit(2)
                .multilineTextAlignment(alignment == .leading ? .leading : .trailing)
            Text(record)
                .font(Theme.Typography.micro)
                .foregroundStyle(.tertiary)
            Text(points.pointsLabel)
                .font(Theme.Typography.metric(.title))
                .padding(.top, 2)
        }
        .frame(maxWidth: .infinity, alignment: alignment == .leading ? .leading : .trailing)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(name), \(record), projected \(points.pointsLabel) points")
    }

    private func rangeSection(analysis: WeeklyAnalysis) -> some View {
        let outlook = analysis.plan.outlook
        return VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
            SectionHeader("Likely range", detail: "10th to 90th percentile")
            VStack(spacing: Theme.Spacing.medium) {
                rangeRow(label: "You", low: outlook.projectedFloor, mid: outlook.projectedPoints,
                         high: outlook.projectedCeiling, tint: Theme.Palette.accent)
                rangeRow(label: "Them", low: outlook.opponentFloor, mid: outlook.projectedOpponentPoints,
                         high: outlook.opponentCeiling, tint: .secondary)
            }
            Text("If your ranges overlap heavily, the week is closer than the projected scores suggest.")
                .font(Theme.Typography.micro)
                .foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .surfaceCard()
    }

    private func rangeRow(label: String, low: Double, mid: Double, high: Double, tint: Color) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.tight) {
            HStack {
                Text(label)
                    .font(Theme.Typography.micro)
                    .foregroundStyle(.secondary)
                Spacer()
                Text("\(low.pointsLabel) – \(high.pointsLabel)")
                    .font(Theme.Typography.metric(.footnote))
                    .foregroundStyle(.secondary)
            }
            GeometryReader { geometry in
                // Both rows share a 0...260 point scale so they are comparable.
                let scale = 260.0
                let start = min(1, max(0, low / scale))
                let end = min(1, max(0, high / scale))
                let center = min(1, max(0, mid / scale))
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.primary.opacity(0.06)).frame(height: 8)
                    Capsule()
                        .fill(tint.opacity(0.35))
                        .frame(width: max(4, geometry.size.width * (end - start)), height: 8)
                        .offset(x: geometry.size.width * start)
                    Circle()
                        .fill(tint)
                        .frame(width: 10, height: 10)
                        .offset(x: max(0, min(geometry.size.width - 10, geometry.size.width * center - 5)))
                }
                .frame(height: 10)
            }
            .frame(height: 10)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(label) projected between \(low.pointsLabel) and \(high.pointsLabel), most likely \(mid.pointsLabel)")
    }

    @ViewBuilder
    private func advantagesSection(analysis: WeeklyAnalysis) -> some View {
        let advantages = analysis.plan.outlook.positionAdvantages
        if !advantages.isEmpty {
            VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
                SectionHeader("Position by position")
                VStack(spacing: Theme.Spacing.medium) {
                    ForEach(advantages) { advantage in
                        AdvantageBar(advantage: advantage)
                    }
                }
                .surfaceCard()
            }
        }
    }

    @ViewBuilder
    private func swingSection(analysis: WeeklyAnalysis) -> some View {
        let analyzer = MatchupAnalyzer(league: model.league ?? DemoLeague.league(), week: analysis.plan.week)
        let swing = analyzer.swingPlayers(
            userLineup: analysis.currentLineup,
            userPlayers: analysis.userPlayers,
            opponentLineup: analysis.opponentLineup,
            opponentPlayers: analysis.opponentPlayers
        )
        if !swing.isEmpty {
            VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
                SectionHeader("Who decides this", detail: "Widest outcomes")
                VStack(spacing: 0) {
                    ForEach(Array(swing.enumerated()), id: \.element.id) { index, player in
                        Button { selectedPlayerID = player.id } label: {
                            HStack(spacing: Theme.Spacing.medium) {
                                PlayerRow(player: player, accessory: .projectionWithRange)
                                Text(analysis.userPlayers[player.id] != nil ? "Yours" : "Theirs")
                                    .font(Theme.Typography.micro)
                                    .foregroundStyle(.tertiary)
                            }
                            .padding(.vertical, Theme.Spacing.small)
                        }
                        .buttonStyle(.plain)
                        if index < swing.count - 1 { Divider() }
                    }
                }
                .padding(.horizontal, Theme.Spacing.medium)
                .background(Theme.Palette.surface, in: RoundedRectangle(cornerRadius: Theme.Radius.medium, style: .continuous))
            }
        }
    }

    @ViewBuilder
    private func opponentLineupSection(analysis: WeeklyAnalysis, opponent: FantasyTeam) -> some View {
        if let lineup = analysis.opponentLineup {
            VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
                SectionHeader(opponent.name, detail: "Projected lineup")
                VStack(spacing: 0) {
                    let assignments = lineup.assignments
                    ForEach(Array(assignments.enumerated()), id: \.offset) { index, assignment in
                        if let id = assignment.playerID, let player = analysis.opponentPlayers[id] {
                            Button { selectedPlayerID = id } label: {
                                PlayerRow(player: player, slot: assignment.slot, accessory: .projection)
                                    .padding(.vertical, Theme.Spacing.small)
                            }
                            .buttonStyle(.plain)
                            if index < assignments.count - 1 { Divider().padding(.leading, 58) }
                        }
                    }
                }
                .padding(.horizontal, Theme.Spacing.medium)
                .background(Theme.Palette.surface, in: RoundedRectangle(cornerRadius: Theme.Radius.medium, style: .continuous))

                Text("Gameplan assumes your opponent starts their best legal lineup, so your position is never overstated.")
                    .font(Theme.Typography.micro)
                    .foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}
