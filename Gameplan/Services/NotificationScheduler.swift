import Foundation
import UserNotifications

/// Schedules the small number of reminders that are genuinely worth interrupting
/// someone for.
///
/// The rule applied throughout: a notification fires only when there is an
/// unresolved action with a real deadline. "Your plan is ready" is not worth a
/// buzz; "your lineup still has a must-do move and kickoff is in two hours" is.
@MainActor
final class NotificationScheduler {
    enum Identifier {
        static let lineupReminder = "gameplan.lineup.reminder"
        static let waiverReminder = "gameplan.waiver.reminder"
        static let planChanged = "gameplan.plan.changed"
    }

    private let center: UNUserNotificationCenter

    init(center: UNUserNotificationCenter = .current()) {
        self.center = center
    }

    /// Asks for permission. Called from Settings and at the end of onboarding,
    /// never on first launch before the user has seen any value.
    @discardableResult
    func requestAuthorization() async -> Bool {
        do {
            return try await center.requestAuthorization(options: [.alert, .sound, .badge])
        } catch {
            AppLog.notifications.error("Notification authorization failed: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    func authorizationStatus() async -> UNAuthorizationStatus {
        await center.notificationSettings().authorizationStatus
    }

    /// Rebuilds every scheduled reminder from the current plan. Called after each
    /// successful analysis, so reminders never describe stale advice.
    func reschedule(
        for plan: GamePlan,
        preferences: AppPreferences,
        lineupDeadline: Date?,
        waiverDeadline: Date?
    ) async {
        center.removePendingNotificationRequests(withIdentifiers: [
            Identifier.lineupReminder,
            Identifier.waiverReminder
        ])

        guard await authorizationStatus() == .authorized else { return }

        if preferences.wantsLineupReminders {
            await scheduleLineupReminder(plan: plan, deadline: lineupDeadline)
        }
        if preferences.wantsWaiverReminders {
            await scheduleWaiverReminder(plan: plan, deadline: waiverDeadline)
        }
    }

    /// Fires when analysis produced a new must-do move that was not there before.
    func notifyPlanChanged(newUrgentMoves: [Recommendation], preferences: AppPreferences) async {
        guard preferences.wantsInjuryAlerts, !newUrgentMoves.isEmpty else { return }
        guard await authorizationStatus() == .authorized else { return }

        let content = UNMutableNotificationContent()
        content.title = "Your game plan changed"
        if newUrgentMoves.count == 1, let move = newUrgentMoves.first {
            content.body = move.title
        } else {
            content.body = "\(newUrgentMoves.count) new moves need your attention."
        }
        content.sound = .default

        await add(
            identifier: Identifier.planChanged,
            content: content,
            trigger: UNTimeIntervalNotificationTrigger(timeInterval: 5, repeats: false)
        )
    }

    func cancelAll() {
        center.removeAllPendingNotificationRequests()
    }

    // MARK: - Private

    private func scheduleLineupReminder(plan: GamePlan, deadline: Date?) async {
        guard let deadline, plan.hasUrgentWork else { return }
        // Ninety minutes before the first kickoff: late enough that injury news
        // has landed, early enough to still act on it.
        let fireDate = deadline.addingTimeInterval(-90 * 60)
        guard fireDate > Date() else { return }

        let content = UNMutableNotificationContent()
        content.title = "Your lineup needs attention"
        let moves = plan.urgentMoves
        content.body = moves.count == 1
            ? moves[0].title
            : "\(moves.count) moves are still outstanding before kickoff."
        content.sound = .default

        await add(
            identifier: Identifier.lineupReminder,
            content: content,
            trigger: trigger(for: fireDate)
        )
    }

    private func scheduleWaiverReminder(plan: GamePlan, deadline: Date?) async {
        guard let deadline else { return }
        let waiverMoves = plan.moves.filter { $0.category == .waiver && $0.priority <= .stronglyConsider }
        guard let top = waiverMoves.first else { return }

        // Three hours before waivers process.
        let fireDate = deadline.addingTimeInterval(-3 * 3600)
        guard fireDate > Date() else { return }

        let content = UNMutableNotificationContent()
        content.title = "Waivers process soon"
        content.body = top.title
        content.sound = .default

        await add(
            identifier: Identifier.waiverReminder,
            content: content,
            trigger: trigger(for: fireDate)
        )
    }

    private func trigger(for date: Date) -> UNCalendarNotificationTrigger {
        let components = Calendar.current.dateComponents(
            [.year, .month, .day, .hour, .minute],
            from: date
        )
        return UNCalendarNotificationTrigger(dateMatching: components, repeats: false)
    }

    private func add(
        identifier: String,
        content: UNNotificationContent,
        trigger: UNNotificationTrigger
    ) async {
        let request = UNNotificationRequest(identifier: identifier, content: content, trigger: trigger)
        do {
            try await center.add(request)
        } catch {
            AppLog.notifications.error("Failed to schedule \(identifier, privacy: .public)")
        }
    }
}
