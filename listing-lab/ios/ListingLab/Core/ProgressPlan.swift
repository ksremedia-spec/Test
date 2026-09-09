import Foundation

/// The run screen's honest clock: step texts and typical seconds per
/// transformation, the bar that eases toward 90% and waits, and the rule that
/// the final step never lights by the clock (Kyle, 28 Aug 2026).
struct ProgressPlan: Equatable {
    let secs: Double
    let steps: [String]
    let sub: String

    static func plan(for t: Transformation) -> ProgressPlan {
        switch t {
        case .twilight:
            return ProgressPlan(secs: 120, steps: [
                "Reading the exterior — rooflines, windows, landscaping",
                "Relighting the sky",
                "Checking nothing about the house itself changed",
                "Looking for the flaws that give AI away",
                "Applying the disclosure",
            ], sub: "A couple of minutes — we inspect every detail before it leaves the lab.")
        case .declutter:
            return ProgressPlan(secs: 150, steps: [
                "Cataloguing what belongs in the room and must stay",
                "Clearing the clutter",
                "Checking every window, door and fitting survived",
                "Confirming the clutter is gone",
                "Applying the disclosure",
            ], sub: "A couple of minutes — we inspect every detail before it leaves the lab.")
        case .empty:
            return ProgressPlan(secs: 150, steps: [
                "Cataloguing the fixed features that must survive",
                "Emptying the room",
                "Checking every window, door and fitting survived",
                "Looking for the flaws that give AI away",
                "Applying the disclosure",
            ], sub: "A couple of minutes — we inspect every detail before it leaves the lab.")
        case .staging:
            return ProgressPlan(secs: 330, steps: [
                "Measuring the room — doors, windows, every fixed feature",
                "Rendering several furnished versions in parallel",
                "Checking each one against the rulebook",
                "Zooming in on artwork, mirrors and rugs",
                "Applying the disclosure to every version that passed — the pick is yours",
            ], sub: "A few minutes — we render several versions. You'll get every one that passes our checks, up to three.")
        }
    }

    /// `min(90, 90·(1 − e^(−t/(secs/2.6))))` — never claims to be finished.
    func percent(elapsed: Double) -> Double {
        min(90, 90 * (1 - exp(-elapsed / (secs / 2.6))))
    }

    /// The current step by the clock. The last step is never reached this way.
    func stepIndex(elapsed: Double) -> Int {
        let byClock = Int(elapsed / (secs / Double(steps.count)))
        return max(0, min(steps.count - 2, byClock))
    }

    /// After 1.6× the typical time the sub line says it is still going.
    var stillGoingAfter: Double { secs * 1.6 }

    static let waitingOnUpstream = "The image service is busy right now. Your photo is still queued — we keep trying, and nothing is charged unless it comes back."
    static let stillGoing = "Still going. Some take longer than others — it will not give up early."
    static func take(_ n: Int) -> String {
        "Take \(n) — the last one didn't meet our bar, so it's being redone. Only a pass gets delivered."
    }

    /// `m:ss`.
    static func clock(_ seconds: Double) -> String {
        let s = max(0, Int(seconds))
        return "\(s / 60):" + String(format: "%02d", s % 60)
    }
}

/// A returned job's sheet: the exact rules from the web (Kyle, 31 Aug 2026).
/// Rejected means the checks refused every tidy-up, so Empty Room goes first;
/// failed means the run never got a fair shot, so the same job again goes first.
struct RerunChoice: Equatable {
    let title: String
    let transformation: Transformation
    let primary: Bool
}

enum ReturnedJob {
    static func title(_ status: JobStatus) -> String {
        status == .rejected ? "Nothing passed the checks" : "That one did not finish"
    }

    /// The explanation when the server sent no `note` (returned-job sheet wording).
    static func defaultNote(_ status: JobStatus) -> String {
        status == .rejected
            ? "No result met our compliance and realism bar, so nothing was delivered."
            : "The run was interrupted before it could finish."
    }

    /// The explanation when the server sent no `note` (fresh result screen wording).
    static func defaultResultNote(_ status: JobStatus) -> String {
        status == .rejected ? "Nothing compliant was produced." : "The run was interrupted before it could finish."
    }

    static let creditsBack = "Your credits came back the moment it ended — this attempt cost you nothing."
    static let declutterHint = "Rooms this full are usually beyond a tidy-up — Empty Room clears everything in one pass, same price."

    static func choices(transformation: Transformation, status: JobStatus, hasPhoto: Bool) -> [RerunChoice] {
        guard hasPhoto else { return [] }
        switch (transformation, status) {
        case (.declutter, .rejected):
            return [RerunChoice(title: "Try Empty Room", transformation: .empty, primary: true),
                    RerunChoice(title: "Run Declutter again", transformation: .declutter, primary: false)]
        case (.declutter, .failed):
            return [RerunChoice(title: "Run Declutter again", transformation: .declutter, primary: true),
                    RerunChoice(title: "Try Empty Room instead", transformation: .empty, primary: false)]
        default:
            return [RerunChoice(title: "Run it again", transformation: transformation, primary: true)]
        }
    }

    /// A rerun carries `style`/`roomType` only when the transformation is unchanged.
    static func rerunRequest(photoId: String, original: Transformation, style: String?, roomType: String?, as next: Transformation) -> JobRequest {
        if next == original {
            return JobRequest(photoId: photoId, transformation: next, style: style, roomType: roomType)
        }
        return JobRequest(photoId: photoId, transformation: next)
    }
}
