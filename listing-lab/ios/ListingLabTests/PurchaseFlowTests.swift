import XCTest
@testable import ListingLab

/// The one rule of the purchase flow: a transaction is finished only once
/// the server has answered, and never on a transient failure.
final class PurchaseFlowTests: XCTestCase {
    private struct Verifier: PurchaseVerifying {
        let answer: Result<IAPVerifyResponse, APIError>
        func verify(signedTransaction: String) async throws -> IAPVerifyResponse { try answer.get() }
    }

    func testAGrantFinishesTheTransactionAndCarriesTheBalance() async {
        let v = Verifier(answer: .success(IAPVerifyResponse(ok: true, granted: 30, balance: 42, alreadyGranted: false)))
        let s = await PurchaseFlow.settle(signedTransaction: "jws", verifier: v)
        XCTAssertEqual(s, .granted(balance: 42, alreadyGranted: false))
        XCTAssertTrue(s.finishesTransaction)
    }

    func testAReplayTheServerAlreadyCountedAlsoFinishes() async {
        let v = Verifier(answer: .success(IAPVerifyResponse(ok: true, granted: 30, balance: 42, alreadyGranted: true)))
        let s = await PurchaseFlow.settle(signedTransaction: "jws", verifier: v)
        XCTAssertEqual(s, .granted(balance: 42, alreadyGranted: true))
        XCTAssertTrue(s.finishesTransaction, "replaying again would change nothing")
    }

    func testAPermanentRefusalFinishesSoItIsNotReplayedForever() async {
        for code in ["IAP_WRONG_APP", "IAP_UNKNOWN_PRODUCT", "IAP_SANDBOX", "IAP_SIGNATURE"] {
            let e = APIError.server(status: 400, code: code, message: "That purchase could not be verified.")
            let s = await PurchaseFlow.settle(signedTransaction: "jws", verifier: Verifier(answer: .failure(e)))
            XCTAssertEqual(s, .refused(e))
            XCTAssertTrue(s.finishesTransaction, code)
        }
    }

    func testAnythingTransientLeavesTheTransactionForTheNextLaunch() async {
        let cases: [APIError] = [
            .server(status: 503, code: "IAP_ROOT_NOT_CONFIGURED", message: "Purchases cannot be confirmed right now — the app will try again automatically."),
            .server(status: 500, code: "INTERNAL", message: "Something went wrong on our end."),
            .server(status: 401, code: "NOT_SIGNED_IN", message: "Sign in to continue."),
            .timeout, .network, .notSignedIn, .decoding,
        ]
        for e in cases {
            let s = await PurchaseFlow.settle(signedTransaction: "jws", verifier: Verifier(answer: .failure(e)))
            XCTAssertEqual(s, .retryLater(e))
            XCTAssertFalse(s.finishesTransaction, "\(e) must not finish the transaction")
        }
    }

    func testTheThreeProductsMatchTheThreePacks() {
        XCTAssertEqual(StoreManager.productIDs, [
            "com.horizonhomemedia.listinglab.credits10",
            "com.horizonhomemedia.listinglab.credits30",
            "com.horizonhomemedia.listinglab.credits75",
        ])
        XCTAssertEqual(StoreManager.credits(for: "com.horizonhomemedia.listinglab.credits30"), 30)
        XCTAssertEqual(StoreManager.credits(for: "com.example.other"), 0)
    }
}
