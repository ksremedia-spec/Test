import SwiftUI

/// The week's win probability, drawn as a single bar with a midpoint marker.
///
/// A bar rather than a dial: the only comparison that matters is against 50%, and
/// a marked midpoint makes that readable at a glance without any labels to parse.
struct WinProbabilityMeter: View {
    var probability: Double
    var posture: WeeklyPosture
    var isEstimate: Bool

    /// Scales with Dynamic Type so the headline number stays readable at large
    /// accessibility sizes.
    @ScaledMetric(relativeTo: .largeTitle) private var numberSize: CGFloat = 44
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var clamped: Double { min(0.99, max(0.01, probability)) }

    private var tint: Color {
        switch posture {
        case .heavyFavorite, .favorite: return Theme.Palette.positive
        case .tossUp: return .secondary
        case .underdog, .heavyUnderdog: return Theme.Palette.negative
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.small) {
            HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.small) {
                Text(clamped.percentLabel)
                    .font(.system(size: numberSize, weight: .bold, design: .rounded).monospacedDigit())
                    .contentTransition(.numericText())
                VStack(alignment: .leading, spacing: 0) {
                    Text("chance to win")
                        .font(Theme.Typography.caption)
                        .foregroundStyle(.secondary)
                    Text(posture.displayName)
                        .font(Theme.Typography.micro)
                        .foregroundStyle(tint)
                }
                Spacer()
            }

            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(Color.primary.opacity(0.08))
                    Capsule()
                        .fill(tint.gradient)
                        .frame(width: max(6, geometry.size.width * clamped))
                    // Midpoint marker — the only reference line that matters.
                    Rectangle()
                        .fill(Color.primary.opacity(0.28))
                        .frame(width: 1.5)
                        .offset(x: geometry.size.width / 2)
                }
            }
            .frame(height: 10)
            .animation(reduceMotion ? nil : Theme.Motion.standard, value: clamped)

            if isEstimate {
                Text("Model estimate from projections, not a published number.")
                    .font(Theme.Typography.micro)
                    .foregroundStyle(.tertiary)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Win probability")
        .accessibilityValue("\(clamped.percentLabel), \(posture.displayName)")
    }
}

#Preview {
    VStack(spacing: 32) {
        WinProbabilityMeter(probability: 0.61, posture: .favorite, isEstimate: true)
        WinProbabilityMeter(probability: 0.34, posture: .underdog, isEstimate: true)
    }
    .padding()
}
