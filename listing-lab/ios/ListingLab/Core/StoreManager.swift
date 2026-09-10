import Foundation
import StoreKit

/// StoreKit is used for exactly one thing: reading which country's store the
/// phone belongs to. Credits are bought on the website through Stripe
/// (decided 10 Sep 2026), and the app may only link out to that in the
/// United States storefront.
enum StorefrontCheck {
    static let unitedStates = "USA"

    /// True when the phone's App Store storefront is the United States.
    static func isUnitedStates() async -> Bool {
        await Storefront.current?.countryCode == unitedStates
    }
}

/// The app's side of a website purchase: Stripe sends the person back to
/// `listinglab://purchase?status=success` (or `cancelled`), and the balance
/// is re-read the way the web does it after checkout — at 1.5 s and again at
/// 4.5 s, because the webhook can land a beat after the redirect.
enum CheckoutReturn {
    enum Status: String, Equatable { case success, cancelled }

    static let scheme = "listinglab"
    static let pollDelays: [Double] = [1.5, 3.0]   // 1.5 s, then 4.5 s from the start

    /// Reads the status out of the URL the return page opens.
    static func status(from url: URL) -> Status? {
        guard url.scheme?.lowercased() == scheme, url.host?.lowercased() == "purchase" else { return nil }
        let raw = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?
            .first { $0.name == "status" }?.value ?? ""
        return Status(rawValue: raw.lowercased())
    }

    enum Outcome: Equatable { case added(balance: Int), notYet(balance: Int?) }

    /// Polls until the balance rises above what it was before the purchase.
    /// `read` fetches the current balance (nil on a failed request);
    /// `wait` sleeps — injectable so the rule is testable without the clock.
    static func settle(before: Int?, read: () async -> Int?, wait: (Double) async -> Void = { try? await Task.sleep(for: .seconds($0)) }) async -> Outcome {
        var latest: Int? = nil
        for delay in pollDelays {
            await wait(delay)
            if let balance = await read() {
                latest = balance
                if let before, balance > before { return .added(balance: balance) }
                if before == nil, balance > 0 { return .added(balance: balance) }
            }
        }
        return .notYet(balance: latest)
    }
}
