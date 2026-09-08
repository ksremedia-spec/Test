import SwiftUI

/// Loading, empty and error presentations.
///
/// Every one of these says what happened and what to do next. A blank screen or a
/// bare spinner tells the user nothing, and in an app whose whole job is to
/// answer "what should I do?", that is the worst possible failure mode.

/// Full-screen analysis progress with real stage text.
struct AnalysisLoadingView: View {
    var stage: AnalysisStage?
    var isDemo: Bool

    private var stages: [AnalysisStage] { AnalysisStage.allCases }

    private var currentIndex: Int {
        guard let stage, let index = stages.firstIndex(of: stage) else { return 0 }
        return index
    }

    var body: some View {
        VStack(spacing: Theme.Spacing.large) {
            Spacer()

            ProgressView()
                .controlSize(.large)

            VStack(spacing: Theme.Spacing.small) {
                Text(stage?.message ?? "Getting your week ready")
                    .font(Theme.Typography.title)
                    .multilineTextAlignment(.center)
                    .contentTransition(.opacity)
                    .animation(Theme.Motion.standard, value: stage)

                Text("This runs on your device and takes a moment.")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(.secondary)
            }

            // A quiet progress trail so the wait feels finite.
            HStack(spacing: 6) {
                ForEach(Array(stages.enumerated()), id: \.element) { index, _ in
                    Capsule()
                        .fill(index <= currentIndex ? Theme.Palette.accent : Color.primary.opacity(0.12))
                        .frame(width: index == currentIndex ? 20 : 8, height: 4)
                        .animation(Theme.Motion.standard, value: currentIndex)
                }
            }

            Spacer()

            if isDemo {
                Label("Demo league", systemImage: "flask")
                    .font(Theme.Typography.micro)
                    .foregroundStyle(.tertiary)
            }
        }
        .screenPadding()
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Analyzing your team. \(stage?.message ?? "")")
    }
}

/// A recoverable failure, with the action that resolves it.
struct ErrorStateView: View {
    var error: AppError
    var onRetry: (() -> Void)? = nil
    var onFixCredentials: (() -> Void)? = nil
    var onUseDemo: (() -> Void)? = nil

    var body: some View {
        ContentUnavailableView {
            Label(error.title, systemImage: error.requiresCredentials ? "lock.trianglebadge.exclamationmark" : "exclamationmark.triangle")
        } description: {
            VStack(spacing: Theme.Spacing.small) {
                if !error.message.isEmpty { Text(error.message) }
                if let suggestion = error.suggestion { Text(suggestion) }
            }
        } actions: {
            VStack(spacing: Theme.Spacing.small) {
                if error.requiresCredentials, let onFixCredentials {
                    Button("Update ESPN connection", action: onFixCredentials)
                        .buttonStyle(.borderedProminent)
                } else if error.isRetryable, let onRetry {
                    Button("Try again", action: onRetry)
                        .buttonStyle(.borderedProminent)
                }
                if let onUseDemo {
                    Button("Explore the demo league", action: onUseDemo)
                        .buttonStyle(.plain)
                        .font(Theme.Typography.caption)
                }
            }
        }
    }
}

/// Nothing to show, but for a good reason.
struct EmptyStateView: View {
    var title: String
    var message: String
    var systemImage: String
    var actionTitle: String? = nil
    var action: (() -> Void)? = nil

    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: systemImage)
        } description: {
            Text(message)
        } actions: {
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .buttonStyle(.bordered)
            }
        }
    }
}

/// Placeholder rows used while a list's data is still arriving.
struct SkeletonRows: View {
    var count: Int = 4

    var body: some View {
        VStack(spacing: Theme.Spacing.medium) {
            ForEach(0..<count, id: \.self) { _ in
                HStack(spacing: Theme.Spacing.medium) {
                    RoundedRectangle(cornerRadius: 4).frame(width: 34, height: 10)
                    VStack(alignment: .leading, spacing: 6) {
                        RoundedRectangle(cornerRadius: 4).frame(height: 12)
                        RoundedRectangle(cornerRadius: 4).frame(width: 120, height: 9)
                    }
                    Spacer()
                    RoundedRectangle(cornerRadius: 4).frame(width: 34, height: 12)
                }
                .foregroundStyle(Color.primary.opacity(0.07))
            }
        }
        .redacted(reason: .placeholder)
        .accessibilityHidden(true)
    }
}

#Preview("Loading") {
    AnalysisLoadingView(stage: .simulating, isDemo: true)
}

#Preview("Error") {
    ErrorStateView(
        error: AppError(
            title: "This league is private and needs your ESPN session details.",
            message: "Re-enter your espn_s2 and SWID values in Settings.",
            suggestion: nil,
            requiresCredentials: true,
            isRetryable: false
        ),
        onRetry: {},
        onFixCredentials: {},
        onUseDemo: {}
    )
}
