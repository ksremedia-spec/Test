import SwiftUI

/// Account: who is signed in, the credit statement, the site's pages,
/// support, sign out, and the deletion Apple requires.
struct AccountView: View {
    @Environment(AppSession.self) private var session
    @State private var page: WebPage?
    @State private var showSupport = false
    @State private var confirmDelete = false
    @State private var deleting = false
    @State private var deleteError: String?

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

                VStack(spacing: 0) {
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
        .alert("Delete my account", isPresented: $confirmDelete) {
            Button("Delete my account", role: .destructive) { Task { await deleteAccount() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This erases your photos, results and account details from our storage. Any credits left on the account are forfeited. It cannot be undone.")
        }
    }

    private func linkRow(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                Text(title).font(Theme.ui(15)).foregroundStyle(Theme.text)
                Spacer()
                Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.textFaint)
            }
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
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
