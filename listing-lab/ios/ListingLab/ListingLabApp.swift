import SwiftUI

/// Listing Lab — AI enhancement built for real estate, as a native iPhone
/// app. A client for https://thelistinglab.app: it uploads a photo, starts
/// a job, and polls until the job finishes. It never talks to an AI vendor,
/// never holds an API key, and never offers a prompt box.
@main
struct ListingLabApp: App {
    @State private var session = AppSession()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(session)
                .preferredColorScheme(.dark)
                .tint(Theme.pine)
        }
        .onChange(of: scenePhase) { _, phase in
            // The native advantage: coming back to the app refreshes the job
            // list and the balance, and settles any purchase still waiting.
            if phase == .active { Task { await session.foregroundRefresh() } }
        }
    }
}
