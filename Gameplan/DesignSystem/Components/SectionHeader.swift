import SwiftUI

/// A section label with optional trailing detail.
///
/// Uppercase, tight tracking, secondary colour — it reads as structure rather
/// than content, which is what lets the screens stay dense without feeling busy.
struct SectionHeader: View {
    var title: String
    var detail: String?
    var action: (title: String, handler: () -> Void)?

    init(_ title: String, detail: String? = nil, action: (title: String, handler: () -> Void)? = nil) {
        self.title = title
        self.detail = detail
        self.action = action
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title.uppercased())
                .font(Theme.Typography.micro)
                .tracking(0.8)
                .foregroundStyle(.secondary)

            Spacer(minLength: Theme.Spacing.small)

            if let detail {
                Text(detail)
                    .font(Theme.Typography.micro)
                    .foregroundStyle(.tertiary)
            }
            if let action {
                Button(action.title, action: action.handler)
                    .font(Theme.Typography.micro)
                    .buttonStyle(.plain)
                    .foregroundStyle(Theme.Palette.accent)
            }
        }
        .accessibilityAddTraits(.isHeader)
    }
}

#Preview {
    VStack(alignment: .leading, spacing: 20) {
        SectionHeader("Winning moves")
        SectionHeader("Watch", detail: "3 situations")
    }
    .padding()
}
