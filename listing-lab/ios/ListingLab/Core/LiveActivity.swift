import Foundation
import ActivityKit

/// The lock-screen / Dynamic Island card for a job in progress (10 Sep 2026).
/// The app starts it when a job starts and updates it while the run screen
/// polls. When the app is not open, the server updates it instead: each
/// card has its own push token, handed to `POST /api/devices/activity`, and
/// the job's finish sends the final state. `reconcile` ends any card whose
/// job the list says is over, for the times neither reached it.
@MainActor
enum JobActivity {
    /// The card stays on the lock screen this long after the job ends.
    static let linger: TimeInterval = 30 * 60

    static var enabled: Bool { ActivityAuthorizationInfo().areActivitiesEnabled }

    static func start(jobId: String, transformation: Transformation, startedAt: Date, session: AppSession) {
        guard enabled, current(jobId) == nil else { return }
        let attributes = JobActivityAttributes(jobId: jobId, label: transformation.label)
        let state = JobActivityAttributes.ContentState(status: "working", take: 1, startedAtUnix: startedAt.timeIntervalSince1970, waitingOnUpstream: false)
        guard let activity = try? Activity.request(attributes: attributes, content: .init(state: state, staleDate: nil), pushType: .token) else { return }
        // The server needs the card's own token to update it while the app is closed.
        Task {
            for await token in activity.pushTokenUpdates {
                let hex = token.map { String(format: "%02x", $0) }.joined()
                await session.sendActivityToken(jobId: jobId, token: hex)
            }
        }
    }

    static func update(jobId: String, take: Int, startedAt: Date, waiting: Bool) {
        guard let activity = current(jobId) else { return }
        let state = JobActivityAttributes.ContentState(status: "working", take: take, startedAtUnix: startedAt.timeIntervalSince1970, waitingOnUpstream: waiting)
        Task { await activity.update(.init(state: state, staleDate: nil)) }
    }

    /// `delivered`, or anything else as `returned`.
    static func end(jobId: String, status: JobStatus) {
        guard let activity = current(jobId) else { return }
        end(activity, status: status)
    }

    /// The list is the source of truth: any card whose job is over, ends.
    static func reconcile(with jobs: [JobSummary]) {
        for activity in Activity<JobActivityAttributes>.activities {
            guard let job = jobs.first(where: { $0.jobId == activity.attributes.jobId }) else { continue }
            if !job.jobStatus.isWorking { end(activity, status: job.jobStatus) }
        }
    }

    static func endAll() {
        for activity in Activity<JobActivityAttributes>.activities {
            Task { await activity.end(nil, dismissalPolicy: .immediate) }
        }
    }

    private static func end(_ activity: Activity<JobActivityAttributes>, status: JobStatus) {
        let previous = activity.content.state
        let final = JobActivityAttributes.ContentState(status: status == .delivered ? "delivered" : "returned",
                                                       take: previous.take, startedAtUnix: previous.startedAtUnix, waitingOnUpstream: false)
        Task { await activity.end(.init(state: final, staleDate: nil), dismissalPolicy: .after(Date().addingTimeInterval(linger))) }
    }

    private static func current(_ jobId: String) -> Activity<JobActivityAttributes>? {
        Activity<JobActivityAttributes>.activities.first { $0.attributes.jobId == jobId }
    }
}
