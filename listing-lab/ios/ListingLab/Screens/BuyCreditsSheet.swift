import SwiftUI

/// `Buy credits` — the web's sheet: the three packs and prices from
/// `/api/packs`, MOST POPULAR on the 30, the quiet promo link. Paying happens
/// on the website: a pack opens the same Stripe Checkout in Safari, and the
/// site's return page brings the person back with `listinglab://purchase`.
/// Only the United States storefront may link out; elsewhere the packs are
/// shown with a line saying where to buy.
struct BuyCreditsSheet: View {
    @Environment(AppSession.self) private var session
    @Environment(\.dismiss) private var dismiss

    @State private var packs: [Pack] = []
    @State private var packsError: String?
    /// nil while the storefront is being read.
    @State private var unitedStates: Bool?
    @State private var startingPack: String?
    @State private var checkout: WebPage?
    @State private var balanceBefore: Int?
    @State private var awaitingReturn = false
    @State private var settling = false
    @State private var notYet = false
    @State private var showPromo = false
    @State private var code = ""
    @State private var redeeming = false

    var body: some View {
        SheetChrome(title: "Buy credits", sub: "Credits never expire. If a photo can't be finished, its credits come back.") {
            switch unitedStates {
            case .some(true):
                Text("You'll pay on our website — it opens in Safari and brings you back here.")
                    .font(Theme.ui(14.5)).foregroundStyle(Theme.textSoft)
            case .some(false):
                Text("Credits can be bought at thelistinglab.app")
                    .font(Theme.ui(14.5)).foregroundStyle(Theme.textSoft)
            case .none:
                EmptyView()
            }
            if packs.isEmpty {
                if let packsError {
                    Text(packsError).font(Theme.ui(14)).foregroundStyle(Theme.textSoft)
                } else {
                    ProgressView().tint(Theme.textSoft).frame(maxWidth: .infinity)
                }
            }
            ForEach(packs) { pack in
                PackRow(pack: pack, tappable: unitedStates == true, busy: startingPack == pack.id || settling) {
                    Task { await buy(pack) }
                }
                .disabled(startingPack != nil || settling)
            }
            if notYet {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Your credits haven't shown up yet — it can take a moment.")
                        .font(Theme.ui(14)).foregroundStyle(Theme.textSoft)
                    Button {
                        Task { await checkAgain() }
                    } label: {
                        if settling { ButtonSpinner() } else { Text("Check again") }
                    }
                    .buttonStyle(PrimaryButtonStyle(small: true))
                    .disabled(settling)
                }
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
        .task {
            async let storefront = StorefrontCheck.isUnitedStates()
            await loadPacks()
            unitedStates = await storefront
        }
        .sheet(item: $checkout, onDismiss: { safariClosed() }) { page in
            SafariView(url: page.url).ignoresSafeArea()
        }
        .onChange(of: session.checkoutReturn) { _, status in
            guard let status else { return }
            session.checkoutReturn = nil
            returned(status)
        }
    }

    private func loadPacks() async {
        do {
            let r: PacksResponse = try await session.api.get("/api/packs")
            packs = r.packs
        } catch let e as APIError {
            packsError = e.message
        } catch {
            packsError = "Something went wrong."
        }
    }

    /// The same checkout the web starts; `platform: ios` only changes where Stripe sends the person afterwards.
    private func buy(_ pack: Pack) async {
        guard unitedStates == true else { return }
        startingPack = pack.id
        defer { startingPack = nil }
        notYet = false
        balanceBefore = session.balance
        do {
            let r: CheckoutResponse = try await session.api.post("/api/checkout", ["packId": pack.id, "platform": "ios"])
            guard let url = URL(string: r.url) else { throw APIError.decoding }
            awaitingReturn = true
            checkout = WebPage(url)
        } catch let e as APIError {
            session.toasts.show(e.isRetryable || e == .decoding ? "Could not start checkout." : e.message)
        } catch {
            session.toasts.show("Could not start checkout.")
        }
    }

    /// The return page opened `listinglab://purchase?status=…`: close Safari and settle.
    private func returned(_ status: CheckoutReturn.Status) {
        awaitingReturn = false
        checkout = nil
        switch status {
        case .success: Task { await settle(expectingCredits: true) }
        case .cancelled: break   // the web only cleans its URL here
        }
    }

    /// Safari was closed by hand (Done) with a checkout in flight: look, quietly.
    private func safariClosed() {
        guard awaitingReturn else { return }
        awaitingReturn = false
        Task { await settle(expectingCredits: false) }
    }

    /// The web's post-checkout refresh: the balance at 1.5 s and again at 4.5 s.
    private func settle(expectingCredits: Bool) async {
        settling = true
        defer { settling = false }
        let outcome = await CheckoutReturn.settle(before: balanceBefore) { await readBalance() }
        switch outcome {
        case .added(let balance):
            session.balance = balance
            await session.refreshCredits()
            dismiss()
            session.toasts.show("Credits added — thank you!")
        case .notYet(let balance):
            if let balance { session.balance = balance }
            if expectingCredits { notYet = true }
        }
    }

    private func checkAgain() async {
        settling = true
        defer { settling = false }
        if let balance = await readBalance() {
            session.balance = balance
            if balance > (balanceBefore ?? 0) {
                await session.refreshCredits()
                dismiss()
                session.toasts.show("Credits added — thank you!")
            }
        }
    }

    private func readBalance() async -> Int? {
        let credits: CreditsResponse? = try? await session.api.get("/api/credits")
        return credits?.balance
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
    let pack: Pack
    let tappable: Bool
    let busy: Bool
    let onTap: () -> Void

    var body: some View {
        Button(action: { if tappable { onTap() } }) {
            HStack(alignment: .center) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        Text("\(pack.credits) credits").font(Theme.ui(16, weight: .semibold)).foregroundStyle(Theme.text)
                        if pack.id == "pack_30" {
                            Text("MOST POPULAR")
                                .font(.system(size: 10.5, weight: .bold))
                                .foregroundStyle(Theme.pineBright)
                                .padding(EdgeInsets(top: 3, leading: 7, bottom: 3, trailing: 7))
                                .background(Theme.pineDeep, in: Capsule())
                        }
                    }
                    Text(usd(dollars: Double(pack.priceCents) / Double(max(pack.credits, 1)) / 100) + " per credit")
                        .font(Theme.ui(12.5)).foregroundStyle(Theme.textFaint)
                }
                Spacer()
                if busy {
                    ProgressView().tint(Theme.brassSoft)
                } else {
                    Text(usd(cents: pack.priceCents)).font(Theme.ui(17, weight: .bold)).foregroundStyle(Theme.brassSoft)
                }
            }
            .padding(EdgeInsets(top: 14, leading: 16, bottom: 14, trailing: 16))
            .background(Theme.surface2, in: RoundedRectangle(cornerRadius: Theme.rMd))
            .overlay(RoundedRectangle(cornerRadius: Theme.rMd).stroke(Theme.line, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .allowsHitTesting(tappable)
        .accessibilityHint(tappable ? "Opens the website to pay" : "")
    }
}
