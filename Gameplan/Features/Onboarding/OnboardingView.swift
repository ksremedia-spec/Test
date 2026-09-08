import SwiftUI

/// Getting to the first useful screen in as few steps as possible.
///
/// The flow is welcome, connect, then a first analysis that ends on a real
/// finding about the user's roster. The demo route exists so nobody is ever
/// blocked at step two — an app that cannot be evaluated without credentials is
/// an app most people never evaluate.
@MainActor
struct OnboardingView: View {
    @Environment(AppModel.self) private var model
    @State private var step: Step = .welcome
    @State private var showsESPNSheet = false
    @ScaledMetric(relativeTo: .largeTitle) private var wordmarkSize: CGFloat = 42

    enum Step {
        case welcome
        case connect
        case analyzing
        case firstFinding
    }

    var body: some View {
        ZStack {
            Theme.Palette.background.ignoresSafeArea()

            switch step {
            case .welcome: welcome
            case .connect: connect
            case .analyzing: analyzing
            case .firstFinding: firstFinding
            }
        }
        .animation(Theme.Motion.standard, value: step)
        .sheet(isPresented: $showsESPNSheet) {
            ESPNConnectionView(isOnboarding: true) {
                showsESPNSheet = false
                beginAnalysis()
            }
        }
    }

    // MARK: - Steps

    private var welcome: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.large) {
            Spacer()

            VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
                Text("Gameplan")
                    .font(.system(size: wordmarkSize, weight: .bold))
                Text("Every week, one clear answer: what should I do to win?")
                    .font(Theme.Typography.title)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
                bullet("bolt.fill", "A ranked list of moves, not a wall of statistics")
                bullet("questionmark.circle.fill", "Every recommendation explains itself")
                bullet("chart.line.uptrend.xyaxis", "Built around your chance of winning, not projected points")
            }
            .padding(.top, Theme.Spacing.small)

            Spacer()

            Button {
                step = .connect
            } label: {
                Text("Get started").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        }
        .screenPadding()
        .padding(.bottom, Theme.Spacing.large)
    }

    private func bullet(_ symbol: String, _ text: String) -> some View {
        HStack(alignment: .top, spacing: Theme.Spacing.medium) {
            Image(systemName: symbol)
                .font(.system(size: 15))
                .foregroundStyle(Theme.Palette.accent)
                .frame(width: 24, height: 22)
            Text(text)
                .font(Theme.Typography.body)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }

    private var connect: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.large) {
            Spacer()

            VStack(alignment: .leading, spacing: Theme.Spacing.small) {
                Text("Connect your league")
                    .font(Theme.Typography.hero)
                Text("Gameplan reads your ESPN league to see your roster, your matchup and who's available.")
                    .font(Theme.Typography.body)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer()

            VStack(spacing: Theme.Spacing.medium) {
                Button {
                    showsESPNSheet = true
                } label: {
                    Label("Connect ESPN Fantasy", systemImage: "link")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)

                Button {
                    model.startDemo()
                    beginAnalysis()
                } label: {
                    Text("Explore with a demo league").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .controlSize(.large)

                Text("The demo league is fictional — invented players and invented statistics — so you can see every screen working before you connect anything.")
                    .font(Theme.Typography.micro)
                    .foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Button("Back") { step = .welcome }
                .font(Theme.Typography.caption)
                .frame(maxWidth: .infinity)
        }
        .screenPadding()
        .padding(.bottom, Theme.Spacing.large)
    }

    private var analyzing: some View {
        AnalysisLoadingView(stage: currentStage, isDemo: model.isDemoData)
            .task { await runFirstAnalysis() }
    }

    /// Waits for the first analysis to land, then moves on. The short floor on the
    /// wait keeps the transition from flashing when the demo answers instantly.
    @MainActor
    private func runFirstAnalysis() async {
        await model.refresh()
        try? await Task.sleep(nanoseconds: 400_000_000)
        step = model.plan != nil ? .firstFinding : .connect
    }

    private var currentStage: AnalysisStage? {
        if case .loading(let stage) = model.loadState { return stage }
        return nil
    }

    @ViewBuilder
    private var firstFinding: some View {
        if let plan = model.plan {
            VStack(alignment: .leading, spacing: Theme.Spacing.large) {
                Spacer()

                VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
                    Text("I've analyzed your roster.")
                        .font(Theme.Typography.hero)
                        .fixedSize(horizontal: false, vertical: true)

                    if let weakness = plan.biggestWeakness {
                        Text(weakness.headline)
                            .font(Theme.Typography.title)
                            .foregroundStyle(Theme.Palette.negative)
                            .fixedSize(horizontal: false, vertical: true)
                    } else {
                        Text("Your roster is in good shape heading into week \(plan.week).")
                            .font(Theme.Typography.title)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                if let firstMove = plan.moves.first(where: { $0.priority != .noAction }) {
                    VStack(alignment: .leading, spacing: Theme.Spacing.tight) {
                        Text("Start here")
                            .font(Theme.Typography.micro)
                            .tracking(0.8)
                            .foregroundStyle(.secondary)
                        Text(firstMove.title)
                            .font(Theme.Typography.rowTitle)
                            .fixedSize(horizontal: false, vertical: true)
                        Text(firstMove.summary)
                            .font(Theme.Typography.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .surfaceCard()
                }

                Spacer()

                VStack(spacing: Theme.Spacing.small) {
                    Button {
                        Task {
                            await model.requestNotificationPermission()
                            model.completeOnboarding()
                        }
                    } label: {
                        Text("See my game plan").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)

                    Text("Gameplan can remind you before kickoff if something still needs a decision.")
                        .font(Theme.Typography.micro)
                        .foregroundStyle(.tertiary)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .screenPadding()
            .padding(.bottom, Theme.Spacing.large)
        } else {
            ErrorStateView(
                error: model.loadState.error ?? AppError(
                    title: "Couldn't analyze your team",
                    message: "Something went wrong reading your league.",
                    suggestion: nil,
                    requiresCredentials: false,
                    isRetryable: true
                ),
                onRetry: { beginAnalysis() },
                onFixCredentials: { showsESPNSheet = true },
                onUseDemo: {
                    model.startDemo()
                    beginAnalysis()
                }
            )
        }
    }

    private func beginAnalysis() {
        // Onboarding is marked complete before analysis so the model will load;
        // the user still lands on the finding screen before the tab bar appears.
        model.completeOnboardingSilently()
        step = .analyzing
    }
}
