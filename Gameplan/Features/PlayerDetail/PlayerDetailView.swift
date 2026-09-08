import SwiftUI
import Charts

/// Everything about one player, organised around the only question that matters
/// to the reader: what does this mean for my team?
///
/// The recommendation and its reasoning come first. Statistics come after, and
/// only the ones that changed the recommendation.
struct PlayerDetailView: View {
    var player: AnalyzedPlayer
    var plan: GamePlan? = nil

    private var relatedMove: Recommendation? {
        plan?.moves.first { $0.action.playerIDs.contains(player.id) }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.section) {
                header
                verdict
                projectionBlock
                if !player.context.playedGames.isEmpty { formChart }
                usageBlock
                if !player.context.significantNews.isEmpty { newsBlock }
                evidenceBlock
            }
            .screenPadding()
            .padding(.vertical, Theme.Spacing.large)
        }
        .background(Theme.Palette.background)
        .navigationTitle(player.player.shortName)
        .navigationBarTitleDisplayMode(.inline)
    }

    // MARK: - Sections

    private var header: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.small) {
            Text(player.player.fullName)
                .font(Theme.Typography.hero)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: Theme.Spacing.small) {
                Text("\(player.position.abbreviation) · \(player.player.team.fullName)")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(.secondary)
                if let environment = player.context.environment {
                    Text(environment.opponentLabel)
                        .font(Theme.Typography.caption)
                        .foregroundStyle(.secondary)
                }
            }

            HStack(spacing: Theme.Spacing.small) {
                if player.player.injury.status != .active {
                    Pill(
                        player.player.injury.status.displayName,
                        systemImage: "cross.case.fill",
                        tint: player.player.injury.status.isUnavailable ? Theme.Palette.negative : Color(red: 0.90, green: 0.52, blue: 0.13)
                    )
                }
                if player.trend != .unknown && player.trend != .steady {
                    Pill(player.trend.displayName, systemImage: player.trend.symbolName,
                         tint: player.trend == .rising ? Theme.Palette.positive : Theme.Palette.negative)
                }
                if let matchup = player.context.environment?.defensiveMatchup, let descriptor = matchup.descriptor {
                    Pill(descriptor)
                }
            }
        }
    }

    @ViewBuilder
    private var verdict: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.small) {
            SectionHeader("What this means for you")
            if let move = relatedMove {
                VStack(alignment: .leading, spacing: Theme.Spacing.tight) {
                    PriorityBadge(priority: move.priority)
                    Text(move.title)
                        .font(Theme.Typography.title)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(move.summary)
                        .font(Theme.Typography.body)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .surfaceCard()
            } else {
                Text(defaultVerdict)
                    .font(Theme.Typography.body)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .surfaceCard()
            }
        }
    }

    private var defaultVerdict: String {
        if player.player.injury.status.isUnavailable {
            return "He won't play this week, so he can't help your lineup. Nothing to decide until his status changes."
        }
        if let plan, plan.moves.contains(where: { $0.priority == .noAction }) {
            return "No change needed here — he's already in the right place in your lineup."
        }
        return "Nothing about this player is currently changing your best lineup."
    }

    private var projectionBlock: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
            SectionHeader("This week", detail: player.projection.source.displayName)

            HStack(alignment: .lastTextBaseline, spacing: Theme.Spacing.large) {
                metric("Projected", player.projection.mean.pointsLabel, emphasis: true)
                metric("Floor", player.projection.floor.pointsLabel)
                metric("Ceiling", player.projection.ceiling.pointsLabel)
            }

            // The range is the point: it is what drives every start/sit call.
            GeometryReader { geometry in
                let span = max(1, player.projection.ceiling - player.projection.floor)
                let position = (player.projection.mean - player.projection.floor) / span
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(Theme.Palette.accent.opacity(0.18))
                        .frame(height: 8)
                    Circle()
                        .fill(Theme.Palette.accent)
                        .frame(width: 12, height: 12)
                        .offset(x: max(0, min(geometry.size.width - 12, geometry.size.width * position - 6)))
                }
                .frame(height: 12)
            }
            .frame(height: 12)

            Text(player.projection.source.disclosure)
                .font(Theme.Typography.micro)
                .foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .surfaceCard()
    }

    private func metric(_ label: String, _ value: String, emphasis: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value)
                .font(emphasis ? Theme.Typography.metric(.title) : Theme.Typography.metric(.title3))
                .foregroundStyle(emphasis ? Color.primary : Color.secondary)
            Text(label)
                .font(Theme.Typography.micro)
                .foregroundStyle(.tertiary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label) \(value) points")
    }

    private var formChart: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
            SectionHeader("Recent form", detail: "Fantasy points by week")
            Chart(player.context.playedGames.sorted { $0.week < $1.week }) { entry in
                BarMark(
                    x: .value("Week", entry.week),
                    y: .value("Points", entry.fantasyPoints),
                    width: .fixed(14)
                )
                .foregroundStyle(Theme.Palette.accent.opacity(0.75))
                .cornerRadius(3)
            }
            .chartYAxis {
                AxisMarks(position: .leading, values: .automatic(desiredCount: 3))
            }
            .chartXAxis {
                AxisMarks(values: .automatic(desiredCount: 5)) { value in
                    AxisValueLabel {
                        if let week = value.as(Int.self) {
                            Text("W\(week)")
                                .font(Theme.Typography.micro)
                        }
                    }
                }
            }
            .frame(height: 120)
            .accessibilityLabel("Fantasy points by week")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .surfaceCard()
    }

    /// One labelled usage statistic.
    private struct UsageRow: Identifiable {
        var id: String { label }
        var label: String
        var value: String
    }

    private var usageRows: [UsageRow] {
        let usage = player.context.bestUsage
        var rows: [UsageRow] = []
        if let value = usage.snapShare { rows.append(UsageRow(label: "Snap share", value: value.percentLabel)) }
        if let value = usage.routeParticipation { rows.append(UsageRow(label: "Route participation", value: value.percentLabel)) }
        if let value = usage.targetShare { rows.append(UsageRow(label: "Target share", value: value.percentLabel)) }
        if let value = usage.targetsPerGame { rows.append(UsageRow(label: "Targets per game", value: String(format: "%.1f", value))) }
        if let value = usage.carriesPerGame { rows.append(UsageRow(label: "Carries per game", value: String(format: "%.1f", value))) }
        if let value = usage.redZoneTouchesPerGame { rows.append(UsageRow(label: "Red-zone touches", value: String(format: "%.1f", value))) }
        if let value = usage.airYardsPerGame { rows.append(UsageRow(label: "Air yards per game", value: String(format: "%.0f", value))) }
        if let value = usage.fantasyPointsPerGame { rows.append(UsageRow(label: "Points per game", value: String(format: "%.1f", value))) }
        return rows
    }

    private var usageBlock: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
            SectionHeader("Usage")
            if usageRows.isEmpty {
                Text("No usage data is available for this player from your league's data source.")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                VStack(spacing: Theme.Spacing.small) {
                    ForEach(usageRows) { row in
                        HStack {
                            Text(row.label)
                                .font(Theme.Typography.body)
                                .foregroundStyle(.secondary)
                            Spacer()
                            Text(row.value)
                                .font(Theme.Typography.metric(.body))
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .surfaceCard()
    }

    private var newsBlock: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
            SectionHeader("News")
            VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
                ForEach(player.context.significantNews) { item in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(item.headline)
                            .font(Theme.Typography.rowTitle)
                            .fixedSize(horizontal: false, vertical: true)
                        if let body = item.body {
                            Text(body)
                                .font(Theme.Typography.caption)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Text("\(item.sourceName) · \(item.publishedAt.formatted(.relative(presentation: .named)))")
                            .font(Theme.Typography.micro)
                            .foregroundStyle(.tertiary)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .surfaceCard()
    }

    private var evidenceBlock: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
            SectionHeader("What went into this")
            EvidenceList(factors: player.factors)
        }
    }
}
