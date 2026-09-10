import SwiftUI

/// Account: who is signed in, the credit statement, the site's pages,
/// support, sign out, and the deletion Apple requires.
struct AccountView: View {
    @Environment(AppSession.self) private var session
    @Environment(AppLock.self) private var lock
    @State private var page: WebPage?
    @State private var showSupport = false
    @State private var confirmDelete = false
    @State private var deleting = false
    @State private var deleteError: String?
    @State private var showIcons = false

    var body: some View {
        NavigationStack {
            StudioPage {
                BrandBar()
                VStack(alignment: .leading, spacing: 6) {
                    Text("Account").font(Theme.display(22, weight: .semibold, relativeTo: .title2)).foregroundStyle(Theme.text)
                    Text(session.account?.email ?? "—").font(Theme.ui(16, weight: .semibold)).foregroundStyle(Theme.text)
                    if let name = session.account?.name, !name.isEmpty {
                        Text(name).font(Theme.ui(14)).foregroundStyle(Theme.textSoft)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .card()

                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        if let balance = session.balance {
                            (Text("\(balance)").bold() + Text(balance == 1 ? " credit" : " credits"))
                                .font(Theme.ui(16)).foregroundStyle(Theme.text)
                        } else {
                            Text("— credits").font(Theme.ui(16)).foregroundStyle(Theme.textSoft)
                        }
                        Spacer()
                        Button("Buy credits") { session.showBuyCredits = true }.buttonStyle(GhostButtonStyle(small: true))
                    }
                }
                .card()

                // Face ID (10 Sep 2026): shown only on a phone that has it set up.
                if let biometry = AppLock.biometryName {
                    HStack {
                        Text("Unlock with \(biometry)").font(Theme.ui(15)).foregroundStyle(Theme.text)
                        Spacer()
                        Toggle("Unlock with \(biometry)", isOn: Binding(
                            get: { lock.enabled },
                            set: { on in Task { await lock.setEnabled(on) } }))
                            .labelsHidden()
                            .tint(Theme.pine)
                    }
                    .card()
                }

                VStack(spacing: 0) {
                    // The statement on its own page (Kyle, 10 Sep 2026: inline it
                    // pushed everything else off the bottom of the screen).
                    NavigationLink { CreditStatementView() } label: { rowLabel("Credit statement") }
                        .buttonStyle(.plain)
                    Rectangle().fill(Theme.line).frame(height: 1)
                    linkRow("App icon") { showIcons = true }
                    Rectangle().fill(Theme.line).frame(height: 1)
                    linkRow("Terms of Service") { page = WebPage(Links.terms) }
                    Rectangle().fill(Theme.line).frame(height: 1)
                    linkRow("Privacy Policy") { page = WebPage(Links.privacy) }
                    Rectangle().fill(Theme.line).frame(height: 1)
                    linkRow("FAQ") { page = WebPage(Links.faq) }
                    Rectangle().fill(Theme.line).frame(height: 1)
                    linkRow("Who built this") { page = WebPage(Links.founder) }
                    Rectangle().fill(Theme.line).frame(height: 1)
                    linkRow("Message support") { showSupport = true }
                }
                .card()

                Button("Sign out") { Task { await session.signOut() } }
                    .buttonStyle(GhostButtonStyle())

                VStack(alignment: .leading, spacing: 10) {
                    if let deleteError { ErrorBox(message: deleteError) }
                    Button { confirmDelete = true } label: {
                        if deleting { ProgressView().tint(Theme.bad) } else { Text("Delete my account") }
                    }
                    .buttonStyle(LinkButtonStyle(color: Theme.bad, size: 14))
                    .disabled(deleting)
                    .frame(maxWidth: .infinity)
                }
            }
            .toolbar(.hidden, for: .navigationBar)
        }
        .task { await session.refreshCredits() }
        .sheet(item: $page) { page in SafariView(url: page.url).ignoresSafeArea() }
        .sheet(isPresented: $showSupport) { SupportSheet() }
        .sheet(isPresented: $showIcons) { AppIconSheet() }
        .alert("Delete my account", isPresented: $confirmDelete) {
            Button("Delete my account", role: .destructive) { Task { await deleteAccount() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This erases your photos, results and account details from our storage. Any credits left on the account are forfeited. It cannot be undone.")
        }
    }

    private func linkRow(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { rowLabel(title) }
            .buttonStyle(.plain)
    }

    private func rowLabel(_ title: String) -> some View {
        HStack {
            Text(title).font(Theme.ui(15)).foregroundStyle(Theme.text)
            Spacer()
            Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.textFaint)
        }
        .padding(.vertical, 12)
        .contentShape(Rectangle())
    }

    private func deleteAccount() async {
        deleting = true
        deleteError = nil
        defer { deleting = false }
        do {
            try await session.deleteAccount()
            session.toasts.show("Your account has been deleted.")
        } catch let e as APIError {
            if e != .notSignedIn { deleteError = e.message }
        } catch {
            deleteError = "Something went wrong."
        }
    }
}

/// The credit statement, on its own page: every entry, newest first, as the
/// website lists them under the balance.
struct CreditStatementView: View {
    @Environment(AppSession.self) private var session

    var body: some View {
        StudioPage {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    if let balance = session.balance {
                        (Text("\(balance)").bold() + Text(balance == 1 ? " credit" : " credits"))
                            .font(Theme.ui(16)).foregroundStyle(Theme.text)
                    } else {
                        Text("— credits").font(Theme.ui(16)).foregroundStyle(Theme.textSoft)
                    }
                    Spacer()
                    Button("Buy credits") { session.showBuyCredits = true }.buttonStyle(GhostButtonStyle(small: true))
                }
                FieldLabel(text: "Credit statement")
                if session.statement.isEmpty {
                    Text("Nothing yet.").font(Theme.ui(13)).foregroundStyle(Theme.textFaint)
                }
                ForEach(session.statement) { entry in
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(entry.description).font(Theme.ui(14)).foregroundStyle(Theme.text)
                            Text(ISO.date(entry.at).map { $0.formatted(date: .abbreviated, time: .shortened) } ?? entry.at)
                                .font(Theme.ui(11)).foregroundStyle(Theme.textFaint)
                        }
                        Spacer()
                        Text(entry.delta > 0 ? "+\(entry.delta)" : "\(entry.delta)")
                            .font(Theme.ui(14, weight: .semibold)).monospacedDigit()
                            .foregroundStyle(entry.delta > 0 ? Theme.readyBadge : Theme.textSoft)
                    }
                }
            }
            .card()
        }
        .navigationTitle("Credit statement")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.bg.opacity(0.92), for: .navigationBar)
        .task { await session.refreshCredits() }
    }
}

/// Three looks for the icon on the Home Screen: the dark one it ships with,
/// a light plate, and the brand blue. iOS shows its own confirmation.
struct AppIconSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var current: String? = UIApplication.shared.alternateIconName
    @State private var error: String?

    private let choices: [(name: String?, title: String, preview: String)] = [
        (nil, "Dark", "IconPreview-Dark"),
        ("AppIcon-Light", "Light", "IconPreview-Light"),
        ("AppIcon-Blue", "Blue", "IconPreview-Blue"),
    ]

    var body: some View {
        NavigationStack {
            StudioPage {
                VStack(alignment: .leading, spacing: 14) {
                    CardHeading(title: "App icon", sub: "Pick the one that suits your Home Screen.")
                    HStack(spacing: 18) {
                        ForEach(choices, id: \.title) { choice in
                            Button {
                                Task { await choose(choice.name) }
                            } label: {
                                VStack(spacing: 8) {
                                    Image(choice.preview)
                                        .resizable().scaledToFit().frame(width: 60, height: 60)
                                        .clipShape(RoundedRectangle(cornerRadius: 14))
                                        .overlay(RoundedRectangle(cornerRadius: 14)
                                            .stroke(current == choice.name ? Theme.pine : Theme.line, lineWidth: current == choice.name ? 2 : 1))
                                    Text(choice.title).font(Theme.ui(13, weight: current == choice.name ? .semibold : .regular))
                                        .foregroundStyle(current == choice.name ? Theme.text : Theme.textSoft)
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    if let error { ErrorBox(message: error) }
                }
                .card()
            }
            .navigationTitle("App icon")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.bg.opacity(0.92), for: .navigationBar)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.medium])
    }

    private func choose(_ name: String?) async {
        guard name != current else { return }
        do {
            try await UIApplication.shared.setAlternateIconName(name)
            current = name
            error = nil
            Haptics.tap()
        } catch {
            self.error = "Couldn't change the icon — try again."
        }
    }
}
