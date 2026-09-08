import SwiftUI

/// Decides which experience the app is in: onboarding, the offseason state, or
/// the weekly tabs.
@MainActor
struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @State private var selectedTab: Tab = .gamePlan

    enum Tab: Hashable {
        case gamePlan, roster, matchup, waivers, more
    }

    var body: some View {
        Group {
            if model.needsOnboarding {
                OnboardingView()
                    .transition(.opacity)
            } else if model.seasonPhase == .offseason || model.seasonPhase == .preseason {
                NavigationStack {
                    OffseasonView(phase: model.seasonPhase)
                        .navigationTitle("Gameplan")
                }
            } else {
                tabs
            }
        }
        .animation(Theme.Motion.standard, value: model.needsOnboarding)
        .task { await bootstrap() }
        .onChange(of: scenePhase) { _, phase in
            // Coming back to the app is exactly when injury news is most likely to
            // have changed, so refresh — the cache keeps it cheap.
            if phase == .active, !model.needsOnboarding, model.analysis != nil {
                model.load()
            }
        }
    }

    @MainActor
    private func bootstrap() async {
        if !model.needsOnboarding && model.analysis == nil {
            model.load()
        }
    }

    private var tabs: some View {
        TabView(selection: $selectedTab) {
            GamePlanView()
                .tabItem { Label("Game Plan", systemImage: "list.star") }
                .tag(Tab.gamePlan)

            RosterView()
                .tabItem { Label("Roster", systemImage: "person.3.fill") }
                .tag(Tab.roster)

            MatchupView()
                .tabItem { Label("Matchup", systemImage: "figure.american.football") }
                .tag(Tab.matchup)

            WaiversView()
                .tabItem { Label("Waivers", systemImage: "arrow.triangle.2.circlepath") }
                .tag(Tab.waivers)

            MoreView()
                .tabItem { Label("More", systemImage: "ellipsis.circle") }
                .tag(Tab.more)
        }
        .tint(Theme.Palette.accent)
    }
}
