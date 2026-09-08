import SwiftUI

/// What the app shows between seasons.
///
/// It stays deliberately small. The product is a weekly in-season decision tool,
/// and an elaborate offseason mode would dilute that. What it does offer is the
/// one thing the engine can genuinely say without live games: an honest read on
/// the roster you're carrying.
@MainActor
struct OffseasonView: View {
    @Environment(AppModel.self) private var model
    var phase: SeasonPhase

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.section) {
                VStack(alignment: .leading, spacing: Theme.Spacing.small) {
                    Text(phase.displayName.uppercased())
                        .font(Theme.Typography.micro)
                        .tracking(1.0)
                        .foregroundStyle(.secondary)
                    Text(headline)
                        .font(Theme.Typography.hero)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(subheadline)
                        .font(Theme.Typography.body)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if let plan = model.plan, !plan.positionAssessments.isEmpty {
                    VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
                        SectionHeader("Where your roster stands")
                        VStack(spacing: Theme.Spacing.small) {
                            ForEach(plan.positionAssessments) { assessment in
                                HStack(alignment: .top, spacing: Theme.Spacing.medium) {
                                    Text(assessment.position.abbreviation)
                                        .font(Theme.Typography.metric(.footnote))
                                        .frame(width: 38, alignment: .leading)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(assessment.descriptor)
                                            .font(Theme.Typography.rowTitle)
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

                VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
                    SectionHeader("Worth doing now")
                    VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
                        task("Check your league settings", "Scoring and roster changes made in the offseason change which players matter. Gameplan reads them from your league, so confirming them here means week one advice is right from the start.")
                        task("Note your weakest position", "The group that struggled last season is usually the one to target early in your draft.")
                        task("Come back at kickoff", "The weekly game plan turns on as soon as the season starts.")
                    }
                }

                Button {
                    model.load(force: true)
                } label: {
                    Label("Refresh league data", systemImage: "arrow.clockwise")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }
            .screenPadding()
            .padding(.vertical, Theme.Spacing.large)
        }
        .background(Theme.Palette.background)
    }

    private var headline: String {
        switch phase {
        case .offseason: return "The season's over. Here's what you're carrying."
        case .preseason: return "Almost there. Week one is close."
        default: return "Between weeks."
        }
    }

    private var subheadline: String {
        switch phase {
        case .offseason:
            return "Gameplan is built around weekly decisions, so there isn't much to decide right now. Your roster assessment still holds, and it's the most useful thing to take into a draft."
        case .preseason:
            return "Your league is connected. As soon as week one opens, the full game plan turns on."
        default:
            return "Check back when this week's games are set."
        }
    }

    private func task(_ title: String, _ detail: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
                .font(Theme.Typography.rowTitle)
            Text(detail)
                .font(Theme.Typography.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}
