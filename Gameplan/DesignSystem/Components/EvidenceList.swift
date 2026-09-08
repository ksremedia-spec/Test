import SwiftUI

/// The supporting evidence behind a recommendation.
///
/// Each row states the fact and, when it is not a measured one, says so. This is
/// the mechanism that lets the app sound confident without overclaiming: the
/// reader can always see whether a line came from their league's data, from the
/// app's arithmetic, or from a model assumption.
struct EvidenceList: View {
    var factors: [RecommendationFactor]
    var showsEvidenceLevel: Bool = true

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.small) {
            ForEach(factors) { factor in
                HStack(alignment: .top, spacing: Theme.Spacing.small) {
                    Image(systemName: symbol(for: factor.direction))
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(tint(for: factor.direction))
                        .frame(width: 14, height: 18)

                    VStack(alignment: .leading, spacing: 2) {
                        Text(factor.summary)
                            .font(Theme.Typography.body)
                            .fixedSize(horizontal: false, vertical: true)

                        if let detail = factor.detail {
                            Text(detail)
                                .font(Theme.Typography.caption)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }

                        if showsEvidenceLevel && factor.evidence != .measured {
                            Text(factor.evidence.disclosure)
                                .font(Theme.Typography.micro)
                                .foregroundStyle(Theme.Palette.evidence(factor.evidence))
                        }
                    }
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("\(directionLabel(factor.direction)). \(factor.summary). \(factor.detail ?? "")")
            }
        }
    }

    private func symbol(for direction: RecommendationFactor.Direction) -> String {
        switch direction {
        case .supporting: return "plus"
        case .opposing: return "minus"
        case .neutral: return "circle.fill"
        }
    }

    private func tint(for direction: RecommendationFactor.Direction) -> Color {
        switch direction {
        case .supporting: return Theme.Palette.positive
        case .opposing: return Theme.Palette.negative
        case .neutral: return Color.secondary.opacity(0.55)
        }
    }

    private func directionLabel(_ direction: RecommendationFactor.Direction) -> String {
        switch direction {
        case .supporting: return "In favor"
        case .opposing: return "Against"
        case .neutral: return "Context"
        }
    }
}

/// The horizontal bar comparing one position group against the opponent's.
struct AdvantageBar: View {
    var advantage: PositionAdvantage

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.tight) {
            HStack {
                Text(advantage.position.abbreviation)
                    .font(Theme.Typography.micro)
                    .frame(width: 34, alignment: .leading)
                Text(advantage.verdict)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Palette.advantage(advantage.margin))
                Spacer()
                Text("\(advantage.userProjected.pointsLabel) – \(advantage.opponentProjected.pointsLabel)")
                    .font(Theme.Typography.metric(.footnote))
                    .foregroundStyle(.secondary)
            }

            GeometryReader { geometry in
                let half = geometry.size.width / 2
                let width = abs(advantage.normalizedMargin) * half
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(Color.primary.opacity(0.07))
                        .frame(height: 6)
                    Capsule()
                        .fill(Theme.Palette.advantage(advantage.margin))
                        .frame(width: max(2, width), height: 6)
                        .offset(x: advantage.margin >= 0 ? half : half - width)
                    Rectangle()
                        .fill(Color.primary.opacity(0.2))
                        .frame(width: 1, height: 12)
                        .offset(x: half)
                }
                .frame(height: 12)
            }
            .frame(height: 12)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(advantage.position.displayName): \(advantage.verdict)")
        .accessibilityValue("You \(advantage.userProjected.pointsLabel), opponent \(advantage.opponentProjected.pointsLabel)")
    }
}

#Preview {
    ScrollView {
        VStack(alignment: .leading, spacing: 24) {
            EvidenceList(factors: [
                RecommendationFactor(summary: "94% route participation", detail: "Ran a route on 94% of his team's dropbacks.", direction: .supporting, evidence: .measured),
                RecommendationFactor(summary: "Tough matchup", detail: "CLE ranks 9th against WRs.", direction: .opposing, evidence: .derived),
                RecommendationFactor(summary: "No weather data", detail: "Outdoor games aren't adjusted.", direction: .neutral, evidence: .estimated)
            ])
            AdvantageBar(advantage: PositionAdvantage(position: .wideReceiver, userProjected: 24.1, opponentProjected: 33.8, userCeiling: 40, opponentCeiling: 52))
            AdvantageBar(advantage: PositionAdvantage(position: .runningBack, userProjected: 31.0, opponentProjected: 21.4, userCeiling: 48, opponentCeiling: 35))
        }
        .padding()
    }
}
