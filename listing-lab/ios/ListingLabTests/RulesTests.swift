import XCTest
@testable import ListingLab

/// The owner's recorded decisions, as logic: the retry matrix, the honest
/// progress clock, and which offers make it onto the screen.
final class RulesTests: XCTestCase {
    func testReturnedDeclutterLeadsWithWhatFitsHowItEnded() {
        let rejected = ReturnedJob.choices(transformation: .declutter, status: .rejected, hasPhoto: true)
        XCTAssertEqual(rejected.map(\.title), ["Try Empty Room", "Run Declutter again"])
        XCTAssertEqual(rejected.map(\.transformation), [.empty, .declutter])
        XCTAssertEqual(rejected.map(\.primary), [true, false])

        let failed = ReturnedJob.choices(transformation: .declutter, status: .failed, hasPhoto: true)
        XCTAssertEqual(failed.map(\.title), ["Run Declutter again", "Try Empty Room instead"])
        XCTAssertEqual(failed.map(\.primary), [true, false])

        for t in [Transformation.empty, .staging, .twilight] {
            for s in [JobStatus.rejected, .failed] {
                let c = ReturnedJob.choices(transformation: t, status: s, hasPhoto: true)
                XCTAssertEqual(c.map(\.title), ["Run it again"], "\(t) \(s)")
                XCTAssertEqual(c[0].transformation, t)
            }
        }
        XCTAssertEqual(ReturnedJob.choices(transformation: .declutter, status: .rejected, hasPhoto: false), [], "no photo, no buttons")
        XCTAssertEqual(ReturnedJob.title(.rejected), "Nothing passed the checks")
        XCTAssertEqual(ReturnedJob.title(.failed), "That one did not finish")
    }

    func testRerunCarriesStyleOnlyWhenTheTransformationIsUnchanged() {
        let same = ReturnedJob.rerunRequest(photoId: "pho_1", original: .staging, style: "Coastal", roomType: "Home Office", as: .staging)
        XCTAssertEqual(same.style, "Coastal")
        XCTAssertEqual(same.roomType, "Home Office")
        let switched = ReturnedJob.rerunRequest(photoId: "pho_1", original: .declutter, style: "Coastal", roomType: "Home Office", as: .empty)
        XCTAssertNil(switched.style, "an Empty Room rerun of a failed declutter takes no style or room type")
        XCTAssertNil(switched.roomType)
        XCTAssertEqual(switched.transformation, "empty")
    }

    func testProgressNeverClaimsToBeFinished() {
        for t in Transformation.allCases {
            let plan = ProgressPlan.plan(for: t)
            XCTAssertEqual(plan.steps.count, 5)
            XCTAssertEqual(plan.steps.last?.hasPrefix("Applying the disclosure"), true, "every transformation ends with the disclosure")
            XCTAssertEqual(plan.percent(elapsed: 0), 0, accuracy: 0.001)
            XCTAssertLessThanOrEqual(plan.percent(elapsed: plan.secs * 10), 90)
            XCTAssertGreaterThan(plan.percent(elapsed: plan.secs), 80)
            XCTAssertEqual(plan.stepIndex(elapsed: 0), 0)
            XCTAssertEqual(plan.stepIndex(elapsed: plan.secs * 100), plan.steps.count - 2, "the final step is never lit by the clock")
            XCTAssertEqual(plan.stillGoingAfter, plan.secs * 1.6, accuracy: 0.001)
        }
        XCTAssertEqual(ProgressPlan.plan(for: .twilight).secs, 120)
        XCTAssertEqual(ProgressPlan.plan(for: .staging).secs, 330)
        XCTAssertEqual(ProgressPlan.plan(for: .declutter).secs, 150)
        XCTAssertEqual(ProgressPlan.clock(0), "0:00")
        XCTAssertEqual(ProgressPlan.clock(65), "1:05")
        XCTAssertEqual(ProgressPlan.clock(600), "10:00")
        XCTAssertEqual(ProgressPlan.take(2), "Take 2 — the last one didn't meet our bar, so it's being redone. Only a pass gets delivered.")
    }

    @MainActor func testOffersComeFromTheServerInItsOrder() {
        XCTAssertEqual(BatchItem.transformations(["twilight"]), [.twilight])
        XCTAssertEqual(BatchItem.transformations(["staging", "declutter"]), [.staging, .declutter])
        XCTAssertEqual(BatchItem.transformations(["something-new"]), Transformation.allCases, "an unknown offer list falls back to all four")
        XCTAssertEqual(BatchItem.transformations([]), Transformation.allCases)
    }
}
