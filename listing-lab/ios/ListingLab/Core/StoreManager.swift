import Foundation
import StoreKit

/// What the server said about a signed transaction.
protocol PurchaseVerifying: Sendable {
    func verify(signedTransaction: String) async throws -> IAPVerifyResponse
}

extension APIClient: PurchaseVerifying {
    func verify(signedTransaction: String) async throws -> IAPVerifyResponse {
        try await post("/api/iap/verify", ["signedTransaction": signedTransaction])
    }
}

/// The one rule of the purchase flow, kept apart from StoreKit so it can be
/// tested: a transaction is FINISHED only once the server has answered. A
/// grant (first time or replay) finishes it; a permanent refusal (a 4xx —
/// wrong app, unknown product, sandbox not allowed) finishes it too, because
/// replaying can never change that answer; anything transient (no signal, a
/// timeout, a 5xx, a lost session) leaves it unfinished so the next launch
/// replays it and nothing the customer paid for is lost.
enum PurchaseFlow {
    enum Settlement: Equatable {
        case granted(balance: Int, alreadyGranted: Bool)
        case refused(APIError)
        case retryLater(APIError)

        var finishesTransaction: Bool {
            switch self {
            case .granted, .refused: return true
            case .retryLater: return false
            }
        }
    }

    static func settle(signedTransaction: String, verifier: PurchaseVerifying) async -> Settlement {
        do {
            let r = try await verifier.verify(signedTransaction: signedTransaction)
            return .granted(balance: r.balance, alreadyGranted: r.alreadyGranted)
        } catch let e as APIError {
            switch e {
            case .server(let status, _, _) where (400..<500).contains(status) && status != 401:
                return .refused(e)
            default:
                return .retryLater(e)
            }
        } catch {
            return .retryLater(.network)
        }
    }
}

/// StoreKit 2: the three consumables, the buy sheet's products, and the
/// replay of unfinished transactions on launch and on foreground.
@MainActor
@Observable
final class StoreManager {
    /// Product ids as the owner creates them in App Store Connect; credits per id.
    static let credits: [String: Int] = [
        "com.horizonhomemedia.listinglab.credits10": 10,
        "com.horizonhomemedia.listinglab.credits30": 30,
        "com.horizonhomemedia.listinglab.credits75": 75,
    ]
    static let productIDs = ["com.horizonhomemedia.listinglab.credits10",
                             "com.horizonhomemedia.listinglab.credits30",
                             "com.horizonhomemedia.listinglab.credits75"]

    var products: [Product] = []
    var loadError: String?
    var purchasing = false

    enum PurchaseResult { case granted(balance: Int), pending, cancelled, refused(String), retryLater(String) }

    private let verifier: PurchaseVerifying
    private let onBalance: (Int) -> Void
    private var updatesTask: Task<Void, Never>?

    init(verifier: PurchaseVerifying, onBalance: @escaping (Int) -> Void) {
        self.verifier = verifier
        self.onBalance = onBalance
        updatesTask = Task { [weak self] in
            // Transactions that arrive outside a purchase call: another device,
            // Ask to Buy approvals, a purchase interrupted mid-flight.
            for await result in Transaction.updates {
                await self?.settle(result)
            }
        }
    }

    static func credits(for productID: String) -> Int { credits[productID] ?? 0 }

    func loadProducts() async {
        do {
            let loaded = try await Product.products(for: StoreManager.productIDs)
            products = loaded.sorted { StoreManager.credits(for: $0.id) < StoreManager.credits(for: $1.id) }
            loadError = products.isEmpty ? "Credit packs are not available right now." : nil
        } catch {
            loadError = "Credit packs are not available right now."
        }
    }

    func purchase(_ product: Product) async -> PurchaseResult {
        purchasing = true
        defer { purchasing = false }
        do {
            switch try await product.purchase() {
            case .success(let verification):
                return await settleForPurchase(verification)
            case .pending:
                return .pending
            case .userCancelled:
                return .cancelled
            @unknown default:
                return .cancelled
            }
        } catch {
            return .retryLater("Could not start the purchase. Try again in a moment.")
        }
    }

    /// Every transaction StoreKit still holds because the server never confirmed it.
    func replayUnfinished() async {
        for await result in Transaction.unfinished {
            await settle(result)
        }
    }

    @discardableResult
    private func settleForPurchase(_ result: VerificationResult<Transaction>) async -> PurchaseResult {
        guard case .verified(let transaction) = result else {
            // StoreKit itself could not verify it; there is nothing to send.
            return .refused("That purchase could not be verified.")
        }
        guard transaction.productType == .consumable, StoreManager.credits[transaction.productID] != nil else {
            await transaction.finish()
            return .refused("That purchase could not be verified.")
        }
        let settlement = await PurchaseFlow.settle(signedTransaction: result.jwsRepresentation, verifier: verifier)
        if settlement.finishesTransaction { await transaction.finish() }
        switch settlement {
        case .granted(let balance, _):
            onBalance(balance)
            return .granted(balance: balance)
        case .refused(let e):
            return .refused(e.message)
        case .retryLater(let e):
            return .retryLater(e.message)
        }
    }

    private func settle(_ result: VerificationResult<Transaction>) async {
        _ = await settleForPurchase(result)
    }
}
