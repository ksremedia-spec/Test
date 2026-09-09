import SwiftUI
import StoreKit

/// `Buy credits` — the three packs as In-App Purchases (Apple's rule for
/// digital credits on iOS), in the web's layout, plus the quiet promo link.
struct BuyCreditsSheet: View {
    @Environment(AppSession.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var showPromo = false
    @State private var code = ""
    @State private var redeeming = false

    private var store: StoreManager { session.store }

    var body: some View {
        SheetChrome(title: "Buy credits", sub: "Credits never expire. If a photo can't be finished, its credits come back.") {
            if store.products.isEmpty {
                if let error = store.loadError {
                    Text(error).font(Theme.ui(14)).foregroundStyle(Theme.textSoft)
                } else {
                    ProgressView().tint(Theme.textSoft).frame(maxWidth: .infinity)
                }
            }
            ForEach(store.products, id: \.id) { product in
                PackRow(product: product, disabled: store.purchasing) { Task { await buy(product) } }
            }
            if showPromo {
                HStack(spacing: 10) {
                    TextField("e.g. LL-A1B2C3", text: $code)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .font(Theme.ui(16)).foregroundStyle(Theme.text)
                        .fieldChrome()
                    Button { Task { await redeem() } } label: { if redeeming { ButtonSpinner() } else { Text("Redeem") } }
                        .buttonStyle(PrimaryButtonStyle(small: true))
                        .disabled(redeeming)
                }
            } else {
                Button("Have a promo code?") { showPromo = true }
                    .buttonStyle(LinkButtonStyle())
            }
            Button("Not now") { dismiss() }.buttonStyle(GhostButtonStyle())
        }
        .task { if store.products.isEmpty { await store.loadProducts() } }
    }

    private func buy(_ product: Product) async {
        switch await store.purchase(product) {
        case .granted:
            dismiss()
            session.toasts.show("Credits added — thank you!")
        case .pending:
            session.toasts.show("Waiting for approval — the credits will be added once the purchase is approved.")
        case .cancelled:
            break
        case .refused(let message), .retryLater(let message):
            session.toasts.show(message)
        }
    }

    private func redeem() async {
        let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        redeeming = true
        defer { redeeming = false }
        do {
            let res: RedeemResponse = try await session.api.post("/api/redeem", ["code": trimmed])
            session.balance = res.balance
            dismiss()
            session.toasts.show("\(creditsWord(res.credits)) added — enjoy!")
        } catch let e as APIError {
            session.toasts.show(e.isRetryable || e == .decoding ? "That code did not work." : e.message)
        } catch {
            session.toasts.show("That code did not work.")
        }
    }
}

/// One `.pack` row: `N credits` (+ MOST POPULAR on the 30), `$X.XX per credit`, the price.
struct PackRow: View {
    let product: Product
    let disabled: Bool
    let onTap: () -> Void

    private var credits: Int { StoreManager.credits(for: product.id) }

    var body: some View {
        Button(action: onTap) {
            HStack(alignment: .center) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        Text("\(credits) credits").font(Theme.ui(16, weight: .semibold)).foregroundStyle(Theme.text)
                        if credits == 30 {
                            Text("MOST POPULAR")
                                .font(.system(size: 10.5, weight: .bold))
                                .foregroundStyle(Theme.pineBright)
                                .padding(EdgeInsets(top: 3, leading: 7, bottom: 3, trailing: 7))
                                .background(Theme.pineDeep, in: Capsule())
                        }
                    }
                    Text(perCredit).font(Theme.ui(12.5)).foregroundStyle(Theme.textFaint)
                }
                Spacer()
                Text(product.displayPrice).font(Theme.ui(17, weight: .bold)).foregroundStyle(Theme.brassSoft)
            }
            .padding(EdgeInsets(top: 14, leading: 16, bottom: 14, trailing: 16))
            .background(Theme.surface2, in: RoundedRectangle(cornerRadius: Theme.rMd))
            .overlay(RoundedRectangle(cornerRadius: Theme.rMd).stroke(Theme.line, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .dimmedWhenDisabled(disabled)
    }

    private var perCredit: String {
        guard credits > 0 else { return "" }
        let each = product.price / Decimal(credits)
        return product.priceFormatStyle.format(each) + " per credit"
    }
}
