import SwiftUI

/// The urgency indicator used throughout the app.
///
/// It is a small dot plus a word, not a filled pill: at the density these lists
/// run, filled badges turn the screen into a traffic light. The dot carries the
/// colour, the label carries the meaning, and VoiceOver reads the label.
struct PriorityBadge: View {
    var priority: RecommendationPriority
    var showsLabel: Bool = true

    var body: some View {
        HStack(spacing: Theme.Spacing.tight) {
            Circle()
                .fill(Theme.Palette.priority(priority))
                .frame(width: 8, height: 8)
            if showsLabel {
                Text(priority.headerName)
                    .font(Theme.Typography.micro)
                    .tracking(0.6)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(priority.displayName)
    }
}

/// A compact numeric or textual chip.
struct Pill: View {
    var text: String
    var systemImage: String?
    var tint: Color

    init(_ text: String, systemImage: String? = nil, tint: Color = .secondary) {
        self.text = text
        self.systemImage = systemImage
        self.tint = tint
    }

    var body: some View {
        HStack(spacing: 4) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.system(size: 10, weight: .semibold))
            }
            Text(text)
                .font(Theme.Typography.micro)
        }
        .foregroundStyle(tint)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(tint.opacity(0.12), in: Capsule())
    }
}

#Preview {
    VStack(alignment: .leading, spacing: 12) {
        PriorityBadge(priority: .mustDo)
        PriorityBadge(priority: .stronglyConsider)
        PriorityBadge(priority: .monitor)
        PriorityBadge(priority: .noAction)
        Pill("QUESTIONABLE", systemImage: "cross.case.fill", tint: .orange)
        Pill("Demo data", systemImage: "flask")
    }
    .padding()
}
