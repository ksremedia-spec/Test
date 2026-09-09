import SwiftUI
import AuthenticationServices

/// Sign in / Create an account. Email + password against the existing API,
/// and Sign in with Apple. No Google on iOS (a browser-redirect flow only a
/// web view can finish); an account made with Google is told so by the server.
struct SignInView: View {
    @Environment(AppSession.self) private var session
    @State private var signingUp = false
    @State private var email = ""
    @State private var password = ""
    @State private var error: String?
    @State private var busy = false
    @State private var showSupport = false
    @State private var legalPage: WebPage?

    var body: some View {
        StudioPage {
            HStack { Wordmark(); Spacer() }
                .padding(.top, 10)
            VStack(alignment: .leading, spacing: 14) {
                CardHeading(title: signingUp ? "Create an account" : "Sign in",
                            sub: "AI enhancement built for real estate.")
                VStack(alignment: .leading, spacing: 6) {
                    FieldLabel(text: "Email")
                    TextField("", text: $email)
                        .textContentType(.emailAddress)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(Theme.ui(16))
                        .foregroundStyle(Theme.text)
                        .fieldChrome()
                }
                VStack(alignment: .leading, spacing: 6) {
                    FieldLabel(text: "Password")
                    SecureField("", text: $password)
                        .textContentType(signingUp ? .newPassword : .password)
                        .font(Theme.ui(16))
                        .foregroundStyle(Theme.text)
                        .fieldChrome()
                }
                if let error { ErrorBox(message: error) }
                Button {
                    Task { await submit() }
                } label: {
                    if busy { ButtonSpinner() } else { Text(signingUp ? "Create account" : "Sign in") }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(busy)

                HStack(spacing: 10) {
                    Rectangle().fill(Theme.line).frame(height: 1)
                    Text("or").font(Theme.ui(13)).foregroundStyle(Theme.textFaint)
                    Rectangle().fill(Theme.line).frame(height: 1)
                }
                SignInWithAppleButton(signingUp ? .signUp : .signIn) { request in
                    request.requestedScopes = [.email, .fullName]
                } onCompletion: { result in
                    Task { await apple(result) }
                }
                .signInWithAppleButtonStyle(.white)
                .frame(height: 50)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .disabled(busy)

                HStack(spacing: 6) {
                    Text(signingUp ? "Already have one?" : "No account yet?")
                        .font(Theme.ui(14)).foregroundStyle(Theme.textSoft)
                    Button(signingUp ? "Sign in" : "Create one") {
                        signingUp.toggle()
                        error = nil
                    }
                    .buttonStyle(LinkButtonStyle(color: Theme.pine, size: 14))
                }
                legalLine
            }
            .card()
        }
        .sheet(isPresented: $showSupport) { SupportSheet() }
        .sheet(item: $legalPage) { page in SafariView(url: page.url).ignoresSafeArea() }
    }

    /// `By signing in or creating an account you agree to the Terms of Service
    /// and Privacy Policy. Need a hand? Message support`
    private var legalLine: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("By signing in or creating an account you agree to the Terms of Service and Privacy Policy. Need a hand? Message support")
                .font(Theme.ui(12)).foregroundStyle(Theme.textFaint)
            HStack(spacing: 14) {
                Button("Terms of Service") { legalPage = WebPage(Links.terms) }
                Button("Privacy Policy") { legalPage = WebPage(Links.privacy) }
                Button("Message support") { showSupport = true }
            }
            .buttonStyle(LinkButtonStyle(color: Theme.pine, size: 12))
        }
    }

    private func submit() async {
        error = nil
        busy = true
        defer { busy = false }
        let trimmed = email.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            if signingUp { try await session.signUp(email: trimmed, password: password) }
            else { try await session.signIn(email: trimmed, password: password) }
        } catch let e as APIError {
            error = e.message
        } catch {
            self.error = "Something went wrong."
        }
    }

    private func apple(_ result: Result<ASAuthorization, Error>) async {
        switch result {
        case .failure(let e):
            // A dismissed Apple sheet is not an error worth a red box.
            if let ae = e as? ASAuthorizationError, ae.code == .canceled { return }
            error = "That Apple sign-in could not be verified — try again."
        case .success(let auth):
            guard let credential = auth.credential as? ASAuthorizationAppleIDCredential,
                  let tokenData = credential.identityToken,
                  let token = String(data: tokenData, encoding: .utf8) else {
                error = "That Apple sign-in could not be verified — try again."
                return
            }
            let code = credential.authorizationCode.flatMap { String(data: $0, encoding: .utf8) }
            busy = true
            defer { busy = false }
            do {
                try await session.signInWithApple(identityToken: token, authorizationCode: code,
                                                  email: credential.email,
                                                  givenName: credential.fullName?.givenName,
                                                  familyName: credential.fullName?.familyName)
            } catch let e as APIError {
                error = e.message
            } catch {
                self.error = "Something went wrong."
            }
        }
    }
}

/// The site's pages the app links to.
enum Links {
    static let terms = URL(string: "https://thelistinglab.app/terms")!
    static let privacy = URL(string: "https://thelistinglab.app/privacy")!
    static let faq = URL(string: "https://thelistinglab.app/faq")!
    static let founder = URL(string: "https://thelistinglab.app/founder")!
}

/// A page to open in Safari's view controller, as a sheet item.
struct WebPage: Identifiable {
    let url: URL
    var id: String { url.absoluteString }
    init(_ url: URL) { self.url = url }
}
