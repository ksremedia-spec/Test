import SwiftUI

/// The home screen: the answer to "what do I need to do this week?".
///
/// The order of the page is the order of the questions a manager actually asks —
/// how am I doing, what should I do, who am I playing, what should I watch, what
/// can wait. Nothing above the fold is decorative.
@MainActor
struct GamePlanView: View {
    @Environment(AppModel.self) private var model
    @State private var selectedMove: Recommendation?
    @State private var selectedPlayerID: PlayerID?

    var body: some View {
        NavigationStack {
            Group {
                switch model.loadState {
                case .idle, .loading:
                    AnalysisLoadingView(
                        stage: currentStage,
                        isDemo: model.isDemoData
                    )
                case .failed(let error):
                    ErrorStateView(
                        error: error,
                        onRetry: { model.load(force: true) },
                        onFixCredentials: nil,
                        onUseDemo: { model.switchToDemo() }
                    )
                case .loaded:
                    if let plan = model.plan {
                        content(for: plan)
                    } else {
                        EmptyStateView(
                            title: "No plan yet",
                            message: "Pull down to run this week's analysis.",
                            systemImage: "sparkles",
                            actionTitle: "Analyze",
                            action: { model.load(force: true) }
                        )
                    }
                }
            }
            .background(Theme.Palette.background)
            .navigationTitle("Game Plan")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    if model.isDemoData {
                        Pill("Demo", systemImage: "flask")
                    }
                }
            }
            .navigationDestination(item: $selectedMove) { move in
                RecommendationDetailView(
                    move: move,
                    players: allPlayers,
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

    /// Opening a move counts as having seen what changed.
    private func open(_ move: Recommendation) {
        selectedMove = move
        if !model.newUrgentMoves.isEmpty {
            withAnimation(Theme.Motion.quick) { model.acknowledgeNewMoves() }
        }
    }

    private var currentStage: AnalysisStage? {
        if case .loading(let stage) = model.loadState { return stage }
        return nil
    }

    private var allPlayers: [PlayerID: AnalyzedPlayer] {
        guard let analysis = model.analysis else { return [:] }
        var combined = analysis.userPlayers
        for candidate in analysis.waiverCandidates {
            combined[candidate.id] = candidate.player
        }
        for (id, player) in analysis.opponentPlayers where combined[id] == nil {
            combined[id] = player
        }
        return combined
    }

    // MARK: - Content

    @ViewBuilder
    private func content(for plan: GamePlan) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.section) {
                hero(for: plan)
                moves(for: plan)
                matchupSummary(for: plan)
                watchList(for: plan)
                restingEasy(for: plan)
                footer(for: plan)
            }
            .screenPadding()
            .padding(.vertical, Theme.Spacing.large)
        }
        .refreshable { await model.refresh() }
    }

    private func hero(for plan: GamePlan) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
            HStack(spacing: Theme.Spacing.small) {
                Text("WEEK \(plan.week)")
                    .font(Theme.Typography.micro)
                    .tracking(1.0)
                    .foregroundStyle(.secondary)
                if let league = model.league {
                    Text(league.name)
                        .font(Theme.Typography.micro)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
            }

            if !model.newUrgentMoves.isEmpty {
                Label(
                    model.newUrgentMoves.count == 1
                        ? "One recommendation changed since you last looked"
                        : "\(model.newUrgentMoves.count) recommendations changed since you last looked",
                    systemImage: "sparkles"
                )
                .font(Theme.Typography.micro)
                .foregroundStyle(Theme.Palette.accent)
                .transition(.opacity)
            }

            Text(plan.headline)
                .font(Theme.Typography.hero)
                .fixedSize(horizontal: false, vertical: true)

            if !plan.positioning.isEmpty {
                Text(plan.positioning)
                    .font(Theme.Typography.body)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            WinProbabilityMeter(
                probability: plan.outlook.winProbability,
                posture: plan.outlook.posture,
                isEstimate: true
            )
            .padding(.top, Theme.Spacing.tight)
        }
    }

    @ViewBuilder
    private func moves(for plan: GamePlan) -> some View {
        let actionable = plan.moves.filter { $0.priority != .noAction }
        VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
            SectionHeader(
                actionable.isEmpty ? "Your lineup" : "Winning moves",
                detail: actionable.isEmpty ? nil : "\(actionable.count)"
            )

            if actionable.isEmpty {
                if let confirmation = plan.moves.first {
                    Button {
                        selectedMove = confirmation
                    } label: {
                        VStack(alignment: .leading, spacing: Theme.Spacing.tight) {
                            PriorityBadge(priority: .noAction)
                            Text(confirmation.title)
                                .font(Theme.Typography.rowTitle)
                            Text(confirmation.summary)
                                .font(Theme.Typography.caption)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .surfaceCard()
                    }
                    .buttonStyle(.plain)
                }
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(actionable.enumerated()), id: \.element.id) { index, move in
                        Button { open(move) } label: {
                            MoveRow(move: move, index: index)
                                .padding(.vertical, Theme.Spacing.medium)
                        }
                        .buttonStyle(.plain)

                        if index < actionable.count - 1 {
                            Divider().padding(.leading, 32)
                        }
                    }
                }
                .padding(.horizontal, Theme.Spacing.medium)
                .background(Theme.Palette.surface, in: RoundedRectangle(cornerRadius: Theme.Radius.medium, style: .continuous))
            }
        }
    }

    @ViewBuilder
    private func matchupSummary(for plan: GamePlan) -> some View {
        if let matchup = model.snapshot?.matchup, let opponent = matchup.opponentTeam {
            VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
                SectionHeader("Matchup", detail: "Week \(plan.week)")

                VStack(spacing: Theme.Spacing.medium) {
                    HStack(alignment: .firstTextBaseline) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(matchup.userTeam.name)
                                .font(Theme.Typography.rowTitle)
                                .lineLimit(1)
                            Text(matchup.userTeam.recordLabel)
                                .font(Theme.Typography.micro)
                                .foregroundStyle(.tertiary)
                        }
                        Spacer(minLength: Theme.Spacing.small)
                        Text(plan.outlook.projectedPoints.pointsLabel)
                            .font(Theme.Typography.metric(.title3))
                        Text("–")
                            .foregroundStyle(.tertiary)
                        Text(plan.outlook.projectedOpponentPoints.pointsLabel)
                            .font(Theme.Typography.metric(.title3))
                            .foregroundStyle(.secondary)
                        Spacer(minLength: Theme.Spacing.small)
                        VStack(alignment: .trailing, spacing: 2) {
                            Text(opponent.name)
                                .font(Theme.Typography.rowTitle)
                                .lineLimit(1)
                            Text(opponent.recordLabel)
                                .font(Theme.Typography.micro)
                                .foregroundStyle(.tertiary)
                        }
                    }

                    ForEach(plan.outlook.positionAdvantages.prefix(3)) { advantage in
                        AdvantageBar(advantage: advantage)
                    }
                }
                .surfaceCard()
            }
        }
    }

    @ViewBuilder
    private func watchList(for plan: GamePlan) -> some View {
        if !plan.watchItems.isEmpty {
            VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
                SectionHeader("Watch", detail: "\(plan.watchItems.count)")
                VStack(spacing: Theme.Spacing.medium) {
                    ForEach(plan.watchItems) { item in
                        WatchItemRow(item: item) {
                            if let id = item.playerID { selectedPlayerID = id }
                        }
                    }
                }
            }
        }
    }

    private func restingEasy(for plan: GamePlan) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.small) {
            SectionHeader("What can wait")
            Text(plan.restingEasy)
                .font(Theme.Typography.body)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func footer(for plan: GamePlan) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.tight) {
            HStack(spacing: Theme.Spacing.small) {
                Pill(plan.dataQuality.descriptor, systemImage: "chart.bar.doc.horizontal")
                if plan.usedLanguageModel {
                    Pill("AI-written", systemImage: "sparkles")
                }
            }
            ForEach(plan.dataQuality.notes, id: \.self) { note in
                Text(note)
                    .font(Theme.Typography.micro)
                    .foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text("Updated \(plan.generatedAt.formatted(date: .omitted, time: .shortened))")
                .font(Theme.Typography.micro)
                .foregroundStyle(.tertiary)
                .padding(.top, Theme.Spacing.tight)
        }
        .padding(.bottom, Theme.Spacing.large)
    }
}

/// A single watch-list entry.
struct WatchItemRow: View {
    var item: WatchItem
    var onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(alignment: .top, spacing: Theme.Spacing.medium) {
                Image(systemName: item.kind.symbolName)
                    .font(.system(size: 14))
                    .foregroundStyle(.secondary)
                    .frame(width: 20, height: 20)

                VStack(alignment: .leading, spacing: 3) {
                    Text(item.title)
                        .font(Theme.Typography.rowTitle)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(item.detail)
                        .font(Theme.Typography.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if let contingency = item.contingency {
                        Text(contingency)
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Palette.accent)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if let description = item.checkByDescription {
                        Label(description, systemImage: "clock")
                            .font(Theme.Typography.micro)
                            .foregroundStyle(.tertiary)
                    }
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .surfaceCard()
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(item.title). \(item.detail). \(item.contingency ?? "")")
    }
}
