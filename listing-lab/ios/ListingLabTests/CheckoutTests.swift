import XCTest
@testable import ListingLab

/// Buying credits on the website from the app: the return link and the
/// balance check that follows it (1.5 s, then 4.5 s, as the web does).
final class CheckoutTests: XCTestCase {
    func testTheReturnLinkCarriesTheStatus() {
        XCTAssertEqual(CheckoutReturn.status(from: URL(string: "listinglab://purchase?status=success")!), .success)
        XCTAssertEqual(CheckoutReturn.status(from: URL(string: "listinglab://purchase?status=cancelled")!), .cancelled)
        XCTAssertEqual(CheckoutReturn.status(from: URL(string: "LISTINGLAB://Purchase?status=Success")!), .success)
        XCTAssertNil(CheckoutReturn.status(from: URL(string: "listinglab://purchase?status=paid")!))
        XCTAssertNil(CheckoutReturn.status(from: URL(string: "listinglab://other?status=success")!))
        XCTAssertNil(CheckoutReturn.status(from: URL(string: "https://thelistinglab.app/purchase/return?status=success")!))
        XCTAssertEqual(CheckoutReturn.scheme, "listinglab")
    }

    func testPollsAtTheWebsTimesAndStopsWhenTheBalanceMoves() async {
        var waits: [Double] = []
        var reads = 0
        let outcome = await CheckoutReturn.settle(before: 5, read: { reads += 1; return reads == 1 ? 5 : 15 },
                                                  wait: { waits.append($0) })
        XCTAssertEqual(outcome, .added(balance: 15))
        XCTAssertEqual(waits, [1.5, 3.0], "1.5 s, then 4.5 s from the start")
        XCTAssertEqual(reads, 2)
    }

    func testAnEarlyWebhookIsSeenOnTheFirstPoll() async {
        var waits: [Double] = []
        let outcome = await CheckoutReturn.settle(before: 0, read: { 10 }, wait: { waits.append($0) })
        XCTAssertEqual(outcome, .added(balance: 10))
        XCTAssertEqual(waits, [1.5])
    }

    func testNoMovementAfterTheSecondPollIsNotYet() async {
        let outcome = await CheckoutReturn.settle(before: 5, read: { 5 }, wait: { _ in })
        XCTAssertEqual(outcome, .notYet(balance: 5))
        let unreachable = await CheckoutReturn.settle(before: 5, read: { nil }, wait: { _ in })
        XCTAssertEqual(unreachable, .notYet(balance: nil))
    }

    func testAnUnknownStartingBalanceCountsAnyCredits() async {
        let outcome = await CheckoutReturn.settle(before: nil, read: { 10 }, wait: { _ in })
        XCTAssertEqual(outcome, .added(balance: 10))
        let still = await CheckoutReturn.settle(before: nil, read: { 0 }, wait: { _ in })
        XCTAssertEqual(still, .notYet(balance: 0))
    }

    func testPackPricesFormatLikeTheWeb() {
        XCTAssertEqual(usd(cents: 1999), "$19.99")
        XCTAssertEqual(usd(dollars: 5699.0 / 30 / 100), "$1.90")
        XCTAssertEqual(usd(dollars: 13799.0 / 75 / 100), "$1.84")
    }
}
