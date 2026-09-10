import UIKit
import UserNotifications

/// Push notifications (10 Sep 2026): a buzz when a photo finishes. The app
/// asks the first time a job starts — the moment a notification has a point —
/// registers with Apple, and hands the phone's token to the server
/// (`POST /api/devices`). Tapping a notification opens My photos.
@MainActor
@Observable
final class Push {
    static let shared = Push()

    /// Which of Apple's two push services this build's tokens belong to:
    /// an Xcode build talks to the sandbox, TestFlight and the App Store to production.
    static let environment: String = {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }()

    private static let tokenKey = "pushDeviceToken"

    /// Apple's token for this phone, as hex. Kept on disk as well: after a
    /// relaunch iOS may not hand it over again, and sign-out needs it to tell
    /// the site to stop (a lesson from the Horizon Home Media app).
    var token: String? {
        didSet {
            UserDefaults.standard.set(token, forKey: Self.tokenKey)
            if token != nil { onToken?() }
        }
    }
    var onToken: (() -> Void)?
    var onOpen: ((String?) -> Void)?

    private init() {
        token = UserDefaults.standard.string(forKey: Self.tokenKey)
    }

    /// Ask once, when it matters. Already answered: just make sure Apple knows this phone.
    func askIfNeeded() async {
        let center = UNUserNotificationCenter.current()
        switch await center.notificationSettings().authorizationStatus {
        case .notDetermined:
            let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
            if granted { register() }
        case .authorized, .provisional, .ephemeral:
            register()
        default:
            break
        }
    }

    /// At launch and sign-in: re-register if allowed, because Apple's token can change.
    func registerIfAllowed() async {
        let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        if status == .authorized || status == .provisional || status == .ephemeral { register() }
    }

    private func register() { UIApplication.shared.registerForRemoteNotifications() }

    func received(deviceToken: Data) {
        token = deviceToken.map { String(format: "%02x", $0) }.joined()
    }

    func opened(_ userInfo: [AnyHashable: Any]) {
        onOpen?(userInfo["jobId"] as? String)
    }
}

/// The UIKit door the push system needs: Apple hands the token and the tapped
/// notification to an app delegate, and nothing else.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in Push.shared.received(deviceToken: deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // The simulator, or no network: the app simply keeps polling.
    }

    /// A push that lands while the app is open still shows — iOS hides it
    /// otherwise, and the person may be on another tab (Kyle's rule from the
    /// Horizon Home Media app).
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .list]
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        await MainActor.run { Push.shared.opened(info) }
    }
}
