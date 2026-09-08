import SwiftUI

/// The full roster, ordered by lineup slot, with the app's verdict on each
/// position group above it.
///
/// The header is the point of the screen: a list of fifteen players is a
/// scoreboard, but "your receivers are the problem" is a decision.
@MainActor
struct RosterView: View {
    @Environment(AppModel.self) private var model
    @State private var selectedPlayerID: PlayerID?
    @State private var showsBench = true

    var body: some View {
        NavigationStack {
            Group {
                if let analysis = model.analysis, let plan = model.plan {
                    content(analysis: analysis, plan: plan)
                } else if model.loadState.isLoading {
                    ScrollView {
                        SkeletonRows(count: 8).screenPadding().padding(.top, Theme.Spacing.large)
                    }
                } else if let error = model.loadState.error {
                    ErrorStateView(error: error, onRetry: { model.load(force: true) }, onUseDemo: { model.switchToDemo() })
                } else {
                    EmptyStateView(
                        title: "No roster yet",
                        message: "Connect a league to see your team.",
                        systemImage: "person.3",
                        actionTitle: nil,
                        action: nil
                    )
                }
            }
            .background(Theme.Palette.background)
            .navigationTitle("Roster")
            .navigationDestination(item: $selectedPlayerID) { id in
                if let player = model.analyzedPlayer(for: id) {
                    PlayerDetailView(player: player, plan: model.plan)
                }
            }
        }
    }

    @ViewBuilder
    private func content(analysis: WeeklyAnalysis, plan: GamePlan) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.section) {
                assessmentSection(plan: plan)
                lineupSection(analysis: analysis)
                benchSection(analysis: analysis)
            }
            .screenPadding()
            .padding(.vertical, Theme.Spacing.large)
        }
        .refreshable { await model.refresh() }
    }

    private func assessmentSection(plan: GamePlan) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
            if let weakness = plan.biggestWeakness {
                VStack(alignment: .leading, spacing: Theme.Spacing.tight) {
                    Text("Your biggest problem")
                        .font(Theme.Typography.micro)
                        .tracking(0.8)
                        .foregroundStyle(.secondary)
                    Text(weakness.headline)
                        .font(Theme.Typography.title)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            SectionHeader("Position groups")
            VStack(spacing: Theme.Spacing.small) {
                ForEach(plan.positionAssessments) { assessment in
                    HStack(alignment: .top, spacing: Theme.Spacing.medium) {
                        Text(assessment.position.abbreviation)
                            .font(Theme.Typography.metric(.footnote))
                            .frame(width: 38, alignment: .leading)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(assessment.descriptor)
                                .font(Theme.Typography.rowTitle)
                                .foregroundStyle(tint(for: assessment))
                            Text(assessment.headline)
                                .font(Theme.Typography.caption)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 0)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .surfaceCard()
        }
    }

    private func tint(for assessment: PositionAssessment) -> Color {
        if assessment.isWeakness { return Theme.Palette.negative }
        if assessment.isStrength { return Theme.Palette.positive }
        return .primary
    }

    private func lineupSection(analysis: WeeklyAnalysis) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
            SectionHeader(
                "Starting lineup",
                detail: analysis.currentLineup.mean.pointsLabel + " projected"
            )
            VStack(spacing: 0) {
                let assignments = analysis.currentLineup.assignments
                ForEach(Array(assignments.enumerated()), id: \.offset) { index, assignment in
                    row(for: assignment, analysis: analysis)
                    if index < assignments.count - 1 {
                        Divider().padding(.leading, 58)
                    }
                }
            }
            .padding(.horizontal, Theme.Spacing.medium)
            .background(Theme.Palette.surface, in: RoundedRectangle(cornerRadius: Theme.Radius.medium, style: .continuous))
        }
    }

    @ViewBuilder
    private func row(for assignment: Lineup.Assignment, analysis: WeeklyAnalysis) -> some View {
        if let id = assignment.playerID, let player = analysis.userPlayers[id] {
            Button { selectedPlayerID = id } label: {
                PlayerRow(
                    player: player,
                    slot: assignment.slot,
                    accessory: .projectionWithRange,
                    isDimmed: player.player.isUnavailable(week: analysis.plan.week)
                )
                .padding(.vertical, Theme.Spacing.small)
            }
            .buttonStyle(.plain)
        } else {
            HStack {
                Text(assignment.slot.displayName)
                    .font(Theme.Typography.micro)
                    .frame(width: 42, alignment: .leading)
                Text("Empty — this slot scores zero")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Palette.negative)
                Spacer()
            }
            .padding(.vertical, Theme.Spacing.medium)
        }
    }

    /// Everyone on the roster who isn't in a starting slot, best first.
    private func benchPlayers(analysis: WeeklyAnalysis) -> [AnalyzedPlayer] {
        let starting = analysis.currentLineup.startingPlayerIDs
        let roster = model.snapshot?.matchup.userTeam.roster ?? []
        return roster
            .filter { !starting.contains($0.id) }
            .compactMap { analysis.userPlayers[$0.id] }
            .sorted { $0.projection.mean > $1.projection.mean }
    }

    @ViewBuilder
    private func benchSection(analysis: WeeklyAnalysis) -> some View {
        let bench = benchPlayers(analysis: analysis)
        if !bench.isEmpty {
            VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
                SectionHeader("Bench", detail: "\(bench.count)", action: (
                    title: showsBench ? "Hide" : "Show",
                    handler: { withAnimation(Theme.Motion.quick) { showsBench.toggle() } }
                ))

                if showsBench {
                    VStack(spacing: 0) {
                        ForEach(Array(bench.enumerated()), id: \.element.id) { index, player in
                            Button { selectedPlayerID = player.id } label: {
                                PlayerRow(
                                    player: player,
                                    slot: .bench,
                                    accessory: .projectionWithRange,
                                    isDimmed: player.player.isUnavailable(week: analysis.plan.week)
                                )
                                .padding(.vertical, Theme.Spacing.small)
                            }
                            .buttonStyle(.plain)
                            if index < bench.count - 1 {
                                Divider().padding(.leading, 58)
                            }
                        }
                    }
                    .padding(.horizontal, Theme.Spacing.medium)
                    .background(Theme.Palette.surface, in: RoundedRectangle(cornerRadius: Theme.Radius.medium, style: .continuous))
                }
            }
        }
    }
}
