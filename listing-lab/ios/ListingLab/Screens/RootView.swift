import SwiftUI

struct RootView: View {
    @Environment(AppSession.self) private var session

    var body: some View {
        Group {
            switch session.phase {
            case .loading:
                // The same picture as the launch screen, so the hand-over from
                // the splash to the first request is invisible.
                ZStack {
                    Theme.paper.ignoresSafeArea()
                    Image("LaunchLockup").resizable().scaledToFit().frame(width: 220, height: 148)
                }
            case .signedOut:
                SignInView()
            case .signedIn:
                MainTabs()
            }
        }
        .toastOverlay()
        .task { await session.boot() }
    }
}

enum Tab: Hashable { case studio, library, account }

/// The three doors: new photos, the library, the account. The web's header
/// (My photos · credit chip · Sign out) becomes a tab bar with the chip in
/// the toolbar and Sign out under Account.
struct MainTabs: View {
    @Environment(AppSession.self) private var session

    var body: some View {
        @Bindable var session = session
        TabView(selection: $session.selectedTab) {
            StudioView()
                .tabItem { Label("New photos", systemImage: "plus.square.on.square") }
                .tag(Tab.studio)
            MyPhotosView()
                .tabItem { Label("My photos", systemImage: "photo.on.rectangle") }
                .tag(Tab.library)
            AccountView()
                .tabItem { Label("Account", systemImage: "person.crop.circle") }
                .tag(Tab.account)
        }
        .tint(Theme.pine)
        .sheet(isPresented: $session.showBuyCredits) { BuyCreditsSheet() }
    }
}

/// The web's header bar (`.bar-in`): the brand on the left, the credit chip
/// on the right. Drawn inside the page rather than as a navigation toolbar,
/// because iOS 26 wraps every toolbar item in a glass capsule of its own —
/// the chip sat inside a second, bigger pill (Kyle, 10 Sep 2026).
struct BrandBar: View {
    var body: some View {
        HStack(spacing: 12) {
            Wordmark(size: 22)
            Spacer(minLength: 8)
            CreditChip()
        }
        .padding(.top, 4)
        .padding(.bottom, 12)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.line).frame(height: 1) }
    }
}

/// The header's credit chip — a button, because it is the only way to buy
/// credits. `— credits` until the first balance arrives. The web's `.chip`:
/// 12.5px, 600, 5px 11px, surface-2 on a line border, soft text with the
/// number in ink.
struct CreditChip: View {
    @Environment(AppSession.self) private var session

    var body: some View {
        Button {
            session.showBuyCredits = true
        } label: {
            Group {
                if let balance = session.balance {
                    (Text("\(balance)").bold().foregroundStyle(Theme.text) + Text(balance == 1 ? " credit" : " credits"))
                } else {
                    Text("— credits")
                }
            }
            .font(Theme.ui(12.5, weight: .semibold))
            .monospacedDigit()
            .lineLimit(1)
            .foregroundStyle(Theme.textSoft)
            .padding(EdgeInsets(top: 5, leading: 11, bottom: 5, trailing: 11))
            .background(Theme.surface2, in: Capsule())
            .overlay(Capsule().stroke(Theme.line, lineWidth: 1))
        }
        .accessibilityLabel("Buy credits")
    }
}

/// The page scaffold every studio card sits in: the dark ground and the
/// 640px-wide column with 18px sides.
struct StudioPage<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) { content }
                .frame(maxWidth: 640)
                .padding(.horizontal, 18)
                .padding(.top, 8)
                .padding(.bottom, 96)
                .frame(maxWidth: .infinity)
        }
        .background(Theme.bg.ignoresSafeArea())
        .scrollDismissesKeyboard(.interactively)
    }
}

/// A card heading in Fraunces with the web's sub line under it.
struct CardHeading: View {
    let title: String
    var sub: String? = nil
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(Theme.display(22, weight: .semibold, relativeTo: .title2))
                .foregroundStyle(Theme.text)
            if let sub {
                Text(sub)
                    .font(Theme.ui(14.5))
                    .foregroundStyle(Theme.textSoft)
                    .lineSpacing(3)
            }
        }
    }
}
