import SwiftUI

struct RootView: View {
    @Environment(AppSession.self) private var session

    var body: some View {
        Group {
            switch session.phase {
            case .loading:
                ZStack {
                    Theme.paper.ignoresSafeArea()
                    Image("LaunchMark").resizable().scaledToFit().frame(width: 120, height: 120)
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

/// The header's credit chip — a button, because it is the only way to buy
/// credits. `— credits` until the first balance arrives.
struct CreditChip: View {
    @Environment(AppSession.self) private var session

    var body: some View {
        Button {
            session.showBuyCredits = true
        } label: {
            Group {
                if let balance = session.balance {
                    (Text("\(balance)").bold() + Text(balance == 1 ? " credit" : " credits"))
                } else {
                    Text("— credits")
                }
            }
            .font(Theme.ui(13, weight: .medium))
            .monospacedDigit()
            .foregroundStyle(Theme.text)
            .padding(EdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 12))
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
