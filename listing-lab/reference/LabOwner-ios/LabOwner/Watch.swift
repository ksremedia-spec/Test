import Foundation
import BackgroundTasks
import UserNotifications
import Combine

/// One job as the site's live feed reports it (last 24 hours).
struct LiveJob: Decodable, Identifiable {
    let id: String
    let who: String
    let what: String
    let opts: String?
    let status: String
    let live: Bool
    let plain: String
    let startedAt: String
    let lastError: String?

    var isBad: Bool { status == "rejected" || status == "failed" }
}

/// Polls the live feed, remembers what it has seen, and posts a notification
/// the first time a job turns up refused or failed. Runs every minute while
/// the app is open, and as a background refresh when it is not — iOS decides
/// exactly when those run (typically every 15 minutes to a few hours, more
/// often for apps you open regularly), so background alerts are best-effort.
@MainActor
final class Watch: ObservableObject {
    static let shared = Watch()
    static let taskID = "app.thelistinglab.owner.refresh"

    @Published var jobs: [LiveJob] = []
    @Published var lastChecked: Date?
    @Published var lastProblem: String?
    @Published var openLiveRequested = false
    @Published var notifyDeliveries: Bool {
        didSet { UserDefaults.standard.set(notifyDeliveries, forKey: "notifyDeliveries") }
    }

    private var timer: Timer?
    private let seenKey = "seenStatuses"   // job id -> status, as of the last check

    private init() {
        notifyDeliveries = UserDefaults.standard.bool(forKey: "notifyDeliveries")
    }

    // MARK: foreground

    func startForeground() {
        stopForeground()
        Task { await check(source: "foreground") }
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            Task { await self?.check(source: "timer") }
        }
    }

    func stopForeground() {
        timer?.invalidate()
        timer = nil
    }

    // MARK: background

    func scheduleBackground() {
        let request = BGAppRefreshTaskRequest(identifier: Watch.taskID)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        do { try BGTaskScheduler.shared.submit(request) } catch { /* already scheduled, or simulator */ }
    }

    nonisolated func handleBackground(_ task: BGAppRefreshTask) {
        let work = Task { @MainActor in
            await self.check(source: "background")
            self.scheduleBackground()
            task.setTaskCompleted(success: true)
        }
        task.expirationHandler = { work.cancel() }
    }

    // MARK: the check

    func requestNotificationPermission() async {
        _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
    }

    func check(source: String) async {
        guard let secret = Secret.load() else { return }
        let url = Secret.url("/internal/board/live.json", secret: secret)
        do {
            let (data, resp) = try await URLSession.shared.data(from: url)
            guard (resp as? HTTPURLResponse)?.statusCode == 200 else {
                lastProblem = "The site answered \((resp as? HTTPURLResponse)?.statusCode ?? 0) — is the secret still right?"
                return
            }
            let fresh = try JSONDecoder().decode([LiveJob].self, from: data)
            await diffAndNotify(fresh)
            jobs = fresh
            lastChecked = Date()
            lastProblem = nil
        } catch {
            lastProblem = "Couldn't reach the site: \(error.localizedDescription)"
        }
    }

    /// Compares this check with the last one. A job that is now refused or
    /// failed, and was not refused/failed last time we looked, earns a
    /// notification. The very first check on a fresh install only records
    /// what is there, so an old backlog doesn't buzz twenty times.
    private func diffAndNotify(_ fresh: [LiveJob]) async {
        let defaults = UserDefaults.standard
        let previous = defaults.dictionary(forKey: seenKey) as? [String: String]
        var now: [String: String] = [:]
        for j in fresh { now[j.id] = j.status }
        defaults.set(now, forKey: seenKey)
        guard let previous else { return }   // first run: learn, don't alert

        for j in fresh {
            let before = previous[j.id]
            let wasBad = before == "rejected" || before == "failed"
            if j.isBad && !wasBad {
                await notify(
                    title: j.status == "rejected" ? "Refused: \(j.what)" : "Failed: \(j.what)",
                    body: "\(j.who) — \(j.lastError ?? j.plain)",
                    id: j.id)
            } else if notifyDeliveries && j.status == "delivered" && before != "delivered" {
                await notify(title: "Delivered: \(j.what)", body: j.who, id: j.id)
            }
        }
    }

    private func notify(title: String, body: String, id: String) async {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.threadIdentifier = "jobs"
        let request = UNNotificationRequest(identifier: id, content: content, trigger: nil)
        try? await UNUserNotificationCenter.current().add(request)
    }
}
