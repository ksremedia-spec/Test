import SwiftUI
import BackgroundTasks
import UserNotifications

/// Lab Owner — Kyle's private view of Listing Lab's back office, on his phone.
/// Never published. It shows the owner pages that already exist on the site
/// (Live, Board, Promos) and buzzes when a job is refused or fails.
@main
struct LabOwnerApp: App {
    @StateObject private var watch = Watch.shared
    @Environment(\.scenePhase) private var scenePhase

    init() {
        // The background refresh must be registered before the app finishes
        // launching, so it lives here rather than in a view.
        BGTaskScheduler.shared.register(forTaskWithIdentifier: Watch.taskID, using: nil) { task in
            Watch.shared.handleBackground(task as! BGAppRefreshTask)
        }
        UNUserNotificationCenter.current().delegate = NotificationRouter.shared
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(watch)
                .preferredColorScheme(.dark)
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active:
                watch.startForeground()
            case .background:
                watch.stopForeground()
                watch.scheduleBackground()
            default:
                break
            }
        }
    }
}

/// Shows a notification banner even while the app is open, and opens the
/// Live tab when one is tapped.
final class NotificationRouter: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationRouter()

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .list]
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse) async {
        await MainActor.run { Watch.shared.openLiveRequested = true }
    }
}
