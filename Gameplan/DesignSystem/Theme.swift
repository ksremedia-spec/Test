import SwiftUI
import UIKit

/// The app's visual language.
///
/// Two rules govern it. First, colour carries meaning and nothing else: the
/// priority palette is reserved for urgency, and everything else is built from
/// system materials so the app looks native in both appearances without a
/// hand-maintained dark palette. Second, hierarchy comes from type and space
/// rather than from boxes — the app leans on a small number of confident type
/// steps instead of nesting cards inside cards.
enum Theme {

    // MARK: - Colour

    enum Palette {
        /// The single accent. Deliberately restrained — it marks the primary
        /// action and nothing else.
        static let accent = Color("AccentColor")

        /// Builds a colour that resolves differently in light and dark.
        ///
        /// The signal colours have to be defined this way rather than as one fixed
        /// value: a red that reads as urgent on white is muddy on black, and a
        /// green that reads as "settled" on black glares on white.
        private static func adaptive(
            light: (Double, Double, Double),
            dark: (Double, Double, Double)
        ) -> Color {
            Color(UIColor { traits in
                let components = traits.userInterfaceStyle == .dark ? dark : light
                return UIColor(
                    red: CGFloat(components.0),
                    green: CGFloat(components.1),
                    blue: CGFloat(components.2),
                    alpha: 1
                )
            })
        }

        /// Priority colours. These are the only place saturated colour is used.
        static func priority(_ priority: RecommendationPriority) -> Color {
            switch priority {
            case .mustDo: return negative
            case .stronglyConsider: return warning
            case .monitor: return caution
            case .noAction: return positive
            }
        }

        static func advantage(_ margin: Double) -> Color {
            if margin > 1.5 { return positive }
            if margin < -1.5 { return negative }
            return Color.secondary
        }

        static func evidence(_ level: EvidenceLevel) -> Color {
            switch level {
            case .measured, .derived: return .secondary
            case .estimated: return caution
            }
        }

        static let positive = adaptive(
            light: (0.13, 0.55, 0.31),
            dark: (0.34, 0.82, 0.52)
        )
        static let negative = adaptive(
            light: (0.80, 0.18, 0.16),
            dark: (1.00, 0.42, 0.38)
        )
        static let warning = adaptive(
            light: (0.85, 0.47, 0.09),
            dark: (1.00, 0.65, 0.28)
        )
        static let caution = adaptive(
            light: (0.72, 0.56, 0.05),
            dark: (0.98, 0.82, 0.32)
        )

        /// Page background. `groupedBackground` gives the familiar iOS settings
        /// feel without needing a bespoke colour set.
        static let background = Color(.systemGroupedBackground)
        static let surface = Color(.secondarySystemGroupedBackground)
        static let subtleSurface = Color(.tertiarySystemGroupedBackground)
        static let separator = Color(.separator)
    }

    // MARK: - Type

    /// All text styles are derived from the system's, so Dynamic Type works
    /// everywhere without per-view handling.
    enum Typography {
        /// The one very large statement per screen.
        static let hero = Font.system(.largeTitle, design: .default, weight: .bold)
        static let title = Font.system(.title2, design: .default, weight: .bold)
        static let sectionHeader = Font.system(.subheadline, design: .default, weight: .semibold)
        static let rowTitle = Font.system(.body, design: .default, weight: .semibold)
        static let body = Font.system(.body)
        static let caption = Font.system(.footnote)
        static let micro = Font.system(.caption2, design: .default, weight: .semibold)

        /// Numbers use the rounded face and monospaced digits so columns of
        /// projections line up and do not jitter while animating.
        static func metric(_ style: Font.TextStyle = .title3) -> Font {
            .system(style, design: .rounded, weight: .semibold).monospacedDigit()
        }
    }

    // MARK: - Layout

    enum Spacing {
        static let hairline: CGFloat = 2
        static let tight: CGFloat = 6
        static let small: CGFloat = 10
        static let medium: CGFloat = 16
        static let large: CGFloat = 24
        static let section: CGFloat = 32
        static let screenEdge: CGFloat = 20
    }

    enum Radius {
        static let small: CGFloat = 8
        static let medium: CGFloat = 14
        static let large: CGFloat = 20
    }

    enum Motion {
        /// One easing curve for the whole app.
        static let standard = Animation.smooth(duration: 0.32)
        static let quick = Animation.smooth(duration: 0.2)
    }
}

// MARK: - Reusable modifiers

private struct SurfaceCard: ViewModifier {
    var padding: CGFloat
    func body(content: Content) -> some View {
        content
            .padding(padding)
            .background(Theme.Palette.surface, in: RoundedRectangle(cornerRadius: Theme.Radius.medium, style: .continuous))
    }
}

extension View {
    /// The app's single container treatment. Used sparingly — most content sits
    /// directly on the page.
    func surfaceCard(padding: CGFloat = Theme.Spacing.medium) -> some View {
        modifier(SurfaceCard(padding: padding))
    }

    /// Standard horizontal inset for full-width screen content.
    func screenPadding() -> some View {
        padding(.horizontal, Theme.Spacing.screenEdge)
    }
}

extension Double {
    /// "12.4" — the app's standard way of writing a points value.
    var pointsLabel: String {
        String(format: "%.1f", self)
    }

    /// "61%"
    var percentLabel: String {
        "\(Int((self * 100).rounded()))%"
    }

    /// "+3.2" with an explicit sign, for margins.
    var signedLabel: String {
        String(format: "%+.1f", self)
    }
}
