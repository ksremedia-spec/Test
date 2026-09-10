import SwiftUI

/// Listing Lab — AI enhancement built for real estate, as a native iPhone
/// app. A client for https://thelistinglab.app: it uploads a photo, starts
/// a job, and polls until the job finishes. It never talks to an AI vendor,
/// never holds an API key, and never offers a prompt box.
@main
struct ListingLabApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var session = AppSession()
    @State private var lock = AppLock()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(session)
                .environment(lock)
                .preferredColorScheme(.dark)
                .tint(Theme.pine)
                .onOpenURL { url in session.handle(url: url) }
                // Face ID: the lock sits over everything until it is passed.
                .overlay { if lock.locked { LockView().environment(lock) } }
        }
        .onChange(of: scenePhase) { _, phase in
            // The native advantage: coming back to the app refreshes the job
            // list and the balance.
            if phase == .active { Task { await session.foregroundRefresh() } }
            if phase == .background { lock.lockIfEnabled() }
        }
    }
}
