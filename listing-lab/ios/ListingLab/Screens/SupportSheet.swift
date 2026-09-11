import SwiftUI

/// Message support — goes through our own domain, not a mailto link, and
/// works signed out because the person who cannot sign in needs it most.
struct SupportSheet: View {
    @Environment(AppSession.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var email = ""
    @State private var message = ""
    @State private var sending = false

    private var signedOut: Bool { session.phase != .signedIn }

    var body: some View {
        SheetChrome(title: "Message support", sub: "Goes straight to a human. We reply by email, usually same day.") {
            if signedOut {
                TextField("Your email (so we can reply)", text: $email)
                    .textContentType(.emailAddress)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(Theme.ui(16)).foregroundStyle(Theme.text)
                    .fieldChrome()
            }
            ZStack(alignment: .topLeading) {
                if message.isEmpty {
                    Text("What can we help with?")
                        .font(Theme.ui(16)).foregroundStyle(Theme.textFaint)
                        .padding(EdgeInsets(top: 20, leading: 18, bottom: 0, trailing: 0))
                }
                TextEditor(text: $message)
                    .scrollContentBackground(.hidden)
                    .font(Theme.ui(16)).foregroundStyle(Theme.text)
                    .frame(minHeight: 120)
                    .fieldChrome()
                    .onChange(of: message) { _, new in if new.count > 4000 { message = String(new.prefix(4000)) } }
            }
            Button {
                Task { await send() }
            } label: {
                if sending { ButtonSpinner() } else { Text(sending ? "Sending…" : "Send message") }
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(sending)
            Button("Cancel") { dismiss() }
                .buttonStyle(GhostButtonStyle())
        }
    }

    private func send() async {
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { session.toasts.show("Write a message first."); return }
        sending = true
        defer { sending = false }
        var body: [String: String] = ["message": text]
        if signedOut { body["email"] = email.trimmingCharacters(in: .whitespacesAndNewlines) }
        do {
            let _: SupportResponse = try await session.api.post("/api/support", body, allow401: true)
            message = ""
            dismiss()
            session.toasts.show("Sent — we'll reply by email.")
        } catch let e as APIError {
            session.toasts.show(e.isRetryable || e == .decoding ? "Could not send — try again in a moment." : e.message)
        } catch {
            session.toasts.show("Could not send — try again in a moment.")
        }
    }
}

/// The bottom-sheet frame the web uses: grab bar, Fraunces title, sub line,
/// then the content, on the surface colour with the sheet radius.
struct SheetChrome<Content: View>: View {
    let title: String
    var sub: String? = nil
    @ViewBuilder var content: Content

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text(title)
                    .font(Theme.display(20, weight: .semibold, relativeTo: .title3))
                    .foregroundStyle(Theme.text)
                    .padding(.top, 6)
                if let sub {
                    Text(sub).font(Theme.ui(14.5)).foregroundStyle(Theme.textSoft)
                }
                content
            }
            .padding(EdgeInsets(top: 14, leading: 20, bottom: 24, trailing: 20))
            .frame(maxWidth: 560, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        /**
         * THE TOAST HAS TO BE ON THE SHEET (Kyle, 11 Sep 2026).
         *
         * "Something not right with this photo?" sent the note and said
         * nothing back. The code was right — it closes the box and shows the
         * website's own thank-you — but the toast is drawn on the root view,
         * and a sheet sits in front of the root view, so every confirmation
         * raised from inside a sheet was rendering behind it, unseen. The
         * report was only the one he noticed; "Credits added — thank you!"
         * after a purchase was invisible in the same way.
         *
         * Every sheet with content is built from this, so saying it once here
         * covers the viewer, the returned chooser, buy credits and support.
         */
        .toastOverlay()
        .scrollDismissesKeyboard(.interactively)
        .presentationDragIndicator(.visible)
        .presentationDetents([.medium, .large])
        .presentationBackground(Theme.surface)
        .presentationCornerRadius(Theme.rLg)
    }
}
