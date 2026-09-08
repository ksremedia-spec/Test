import SwiftUI

/// One row in the "winning moves" list.
///
/// Rank, priority, the action as a sentence, and the single most compelling
/// reason. Everything else is one tap away — the list has to be readable in about
/// ten seconds, which means one idea per row.
struct MoveRow: View {
    var move: Recommendation
    var index: Int

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.medium) {
            Text("\(index + 1)")
                .font(Theme.Typography.metric(.footnote))
                .foregroundStyle(.tertiary)
                .frame(width: 16, alignment: .trailing)
                .padding(.top, 2)

            VStack(alignment: .leading, spacing: Theme.Spacing.tight) {
                HStack(spacing: Theme.Spacing.small) {
                    PriorityBadge(priority: move.priority)
                    if let label = move.winProbabilityLabel {
                        Text(label)
                            .font(Theme.Typography.micro)
                            .foregroundStyle(Theme.Palette.positive)
                    }
                }

                Text(move.title)
                    .font(Theme.Typography.rowTitle)
                    .fixedSize(horizontal: false, vertical: true)

                Text(move.summary)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                if let deadline = move.deadlineDescription {
                    Label(deadline, systemImage: "clock")
                        .font(Theme.Typography.micro)
                        .foregroundStyle(.tertiary)
                        .padding(.top, 1)
                }
            }

            Spacer(minLength: 0)

            Image(systemName: "chevron.right")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.tertiary)
                .padding(.top, 4)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Move \(index + 1), \(move.priority.displayName). \(move.title). \(move.summary)")
        .accessibilityHint("Opens the full reasoning")
    }
}
