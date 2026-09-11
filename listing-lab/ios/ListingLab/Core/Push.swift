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
    /// A push landed while the app was open: the screens refresh instead of
    /// asking the server on a timer (11 Sep 2026).
    var onArrive: (() -> Void)?

    /// True when notifications are allowed AND Apple has given this phone a
    /// token the server can reach it on. Only then is polling the fallback
    /// rather than the mechanism — if the person said no to notifications,
    /// the app must go on asking or their photos would never appear.
    private(set) var authorized = false
    var isDelivering: Bool { authorized && token != nil }

    /// Re-read Apple's answer; the person can change it in Settings at any time.
    func refreshAuthorization() async {
        let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        authorized = status == .authorized || status == .provisional || status == .ephemeral
    }

    private init() {
        token = UserDefaults.standard.string(forKey: Self.tokenKey)
    }

    /// Ask once, when it matters. Already answered: just make sure Apple knows this phone.
    func askIfNeeded() async {
        let center = UNUserNotificationCenter.current()
        switch await center.notificationSettings().authorizationStatus {
        case .notDetermined:
            let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
            authorized = granted
            if granted { register() }
        case .authorized, .provisional, .ephemeral:
            authorized = true
            register()
        default:
            authorized = false
        }
    }

    /// At launch and sign-in: re-register if allowed, because Apple's token can change.
    func registerIfAllowed() async {
        await refreshAuthorization()
        if authorized { register() }
    }

    private func register() { UIApplication.shared.registerForRemoteNotifications() }

    func received(deviceToken: Data) {
        token = deviceToken.map { String(format: "%02x", $0) }.joined()
    }

    func opened(_ userInfo: [AnyHashable: Any]) {
        onOpen?(userInfo["jobId"] as? String)
    }

    func arrived() { onArrive?() }
}

/// The UIKit door the push system needs: Apple hands the token and the tapped
/// notification to an app delegate, and nothing else.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        // Reconnect to any upload the system carried on with while the app
        // was away, so its result is delivered rather than waiting.
        BackgroundUploader.shared.reconnect()
        return true
    }

    /// iOS woke the app because an upload it was carrying finished. Hold its
    /// completion handler until every event has been delivered.
    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String,
                     completionHandler: @escaping () -> Void) {
        guard identifier == BackgroundUploader.identifier else { completionHandler(); return }
        // UIKit's handler predates strict concurrency checking. It is only
        // ever called back on the main queue, which is the promise here.
        let handler = UncheckedSendable(completionHandler)
        BackgroundUploader.shared.setSystemWakeCompletion { handler.value() }
        BackgroundUploader.shared.reconnect()
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
        // It is also the signal to refresh: the job it names has finished.
        await MainActor.run { Push.shared.arrived() }
        return [.banner, .sound, .list]
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        await MainActor.run { Push.shared.opened(info) }
    }
}

/// A value the compiler cannot prove is safe to hand between threads, where
/// the surrounding code proves it instead.
struct UncheckedSendable<T>: @unchecked Sendable {
    let value: T
    init(_ value: T) { self.value = value }
}
