import SwiftUI

/// `Working on it` — the honest progress screen. Polls the job every 4s,
/// ticks the clock every second, eases the bar toward 90% and never past it,
/// and never lights the final step by the clock. Leaving this screen stops
/// its poll; My photos is the source of truth.
struct RunView: View {
    @Environment(AppSession.self) private var session
    let context: RunContext
    let onFinished: (ResultContext) -> Void

    @State private var elapsed: Double = 0
    @State private var waiting = false
    @State private var take = 1
    @State private var beforeImage: UIImage?

    private var plan: ProgressPlan { .plan(for: context.transformation) }

    var body: some View {
        StudioPage {
            VStack(alignment: .leading, spacing: 14) {
                CardHeading(title: "Working on it", sub: subText)
                ProgressBar(percent: plan.percent(elapsed: elapsed))
                steps
                Text(ProgressPlan.clock(elapsed))
                    .font(Theme.ui(14)).monospacedDigit().foregroundStyle(Theme.textSoft)
                Text("You can safely close the app — this keeps running.")
                    .font(Theme.ui(13)).foregroundStyle(Theme.textFaint)
            }
            .card()
        }
        .navigationBarBackButtonHidden(true)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("My photos") { session.selectedTab = .library }
                    .buttonStyle(LinkButtonStyle(color: Theme.textSoft, size: 14))
            }
            ToolbarItem(placement: .topBarTrailing) { CreditChip() }
        }
        .task { await watch() }
    }

    private var subText: String {
        if waiting { return ProgressPlan.waitingOnUpstream }
        if elapsed > plan.stillGoingAfter { return ProgressPlan.stillGoing }
        if take > 1 { return ProgressPlan.take(take) }
        return plan.sub
    }

    private var steps: some View {
        let current = plan.stepIndex(elapsed: elapsed)
        return VStack(alignment: .leading, spacing: 9) {
            ForEach(Array(plan.steps.enumerated()), id: \.offset) { i, text in
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Circle()
                        .fill(i < current ? Theme.ok : (i == current ? Theme.pine : Theme.line))
                        .frame(width: 8, height: 8)
                        .offset(y: -2)
                    Text(text)
                        .font(Theme.ui(14))
                        .foregroundStyle(i == current ? Theme.text : Theme.textFaint)
                }
            }
        }
    }

    /// One loop: the clock every second, the server every fourth second
    /// (first call immediately). A network blip is not a failed job.
    private func watch() async {
        var base = context.startedAt ?? Date()
        var tick = 0
        var lastAttempts = 0
        JobActivity.start(jobId: context.jobId, transformation: context.transformation, startedAt: base, session: session)
        while !Task.isCancelled {
            elapsed = Date().timeIntervalSince(base)
            if tick % 4 == 0 {
                do {
                    let job: JobPoll = try await session.api.get("/api/jobs/\(context.jobId)")
                    waiting = job.waitingOnUpstream ?? false
                    if let used = job.attemptsUsed, used > 1, used != lastAttempts, job.jobStatus.isWorking {
                        // Take n: the clock and the bar restart, the steps walk again.
                        lastAttempts = used
                        take = used
                        base = Date()
                    }
                    if !job.jobStatus.isWorking {
                        JobActivity.end(jobId: context.jobId, status: job.jobStatus)
                        if job.jobStatus == .delivered { Haptics.success() } else { Haptics.warning() }
                        finish(job)
                        return
                    }
                    JobActivity.update(jobId: context.jobId, take: take, startedAt: base, waiting: waiting)
                } catch let e as APIError {
                    if e == .notSignedIn { return }
                    if case .server(let status, _, _) = e, status == 404 {
                        JobActivity.end(jobId: context.jobId, status: .failed)
                        finish(status: "failed", note: "We lost track of that job.")
                        return
                    }
                } catch {}
            }
            tick += 1
            try? await Task.sleep(for: .seconds(1))
        }
    }

    private func finish(_ job: JobPoll) {
        onFinished(ResultContext(jobId: context.jobId, transformation: context.transformation,
                                 photoId: context.photoId, originalPath: context.originalPath,
                                 status: job.status, resultUrl: job.resultUrl, variantUrls: job.variants,
                                 note: job.note, customerMessage: job.customerMessage))
    }

    private func finish(status: String, note: String) {
        onFinished(ResultContext(jobId: context.jobId, transformation: context.transformation,
                                 photoId: context.photoId, originalPath: context.originalPath,
                                 status: status, resultUrl: nil, variantUrls: [], note: note, customerMessage: nil))
    }
}
