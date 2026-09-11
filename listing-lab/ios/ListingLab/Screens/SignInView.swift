import SwiftUI
import AuthenticationServices

/// Sign in / Create an account. Email + password against the existing API,
/// Sign in with Apple, and Continue with Google — the website's own Google
/// flow in a sheet over the app, finished by `AppSession.handle(url:)` when
/// the site's return page opens `listinglab://signin`. The Google button
/// shows only when `/api/auth/config` says the server has it, as on the web.
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
        @Bindable var session = session
        StudioPage {
            HStack { Wordmark(); Spacer() }
                .padding(.top, 10)
            ProofHero()
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

                if session.googleAvailable {
                    Button {
                        error = nil
                        session.startGoogleSignIn()
                    } label: {
                        if session.googleExchanging {
                            ButtonSpinner()
                        } else {
                            HStack(spacing: 10) {
                                GoogleMark().frame(width: 18, height: 18)
                                Text("Continue with Google")
                            }
                        }
                    }
                    .buttonStyle(GoogleButtonStyle())
                    .disabled(busy || session.googleExchanging)
                }

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
        // Google's sign-in page, in a sheet over the app. The site's return
        // page opens listinglab://signin, which closes this and finishes.
        .sheet(item: $session.googleSignIn) { flow in SafariView(url: flow.url).ignoresSafeArea() }
        .onChange(of: session.googleSignInError) { _, message in
            guard let message else { return }
            error = message
            session.googleSignInError = nil
        }
        .task { await session.checkGoogleAvailable() }
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
            error = "That sign-in could not be verified — try again."
        case .success(let auth):
            guard let credential = auth.credential as? ASAuthorizationAppleIDCredential,
                  let tokenData = credential.identityToken,
                  let token = String(data: tokenData, encoding: .utf8) else {
                error = "That sign-in could not be verified — try again."
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

/// WHAT THE WEBSITE SAYS BEFORE THE SIGN-IN FORM (Kyle, 11 Sep 2026).
///
/// On the website nobody reaches the sign-in box without scrolling past the
/// before-and-afters, the checks and the price. Arriving from the App Store
/// is the other way round: the form is the first thing there is, and a
/// stranger has seen no evidence any of this works.
///
/// So the top of the signed-out screen is the product doing its four things.
/// It moves on by itself every few seconds, and stops the moment the person
/// takes over — picking a fix or dragging the handle — because something
/// that keeps moving while you are trying to look at it is an advert, and
/// something that waits is a demonstration.
///
/// Not a card sitting on the screen: no box, no border, the picture at the
/// full width of the column with the names under it. The card below is the
/// sign-in form, and it is the only card here.
struct ProofHero: View {
    /// The four, in the order the studio offers them.
    private static let show: [(label: String, before: String, after: String)] = [
        // The owner board's names for the four, which are the short ones —
        // "Empty the room" and "Virtual staging" do not fit four across.
        ("Declutter", "ProofDeclutterBefore", "ProofDeclutterAfter"),
        ("Empty Room", "ProofEmptyBefore", "ProofEmptyAfter"),
        ("Virtual Staging", "ProofStagingBefore", "ProofStagingAfter"),
        ("Twilight", "ProofTwilightBefore", "ProofTwilightAfter"),
    ]
    private static let dwell: Duration = .seconds(4)

    @State private var index = 0
    @State private var advancing = true

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            let item = Self.show[index]
            BeforeAfterSlider(before: UIImage(named: item.before),
                              after: UIImage(named: item.after) ?? UIImage(),
                              onTouch: { advancing = false })
                // A fresh slider per fix, so the handle starts in the middle
                // again instead of inheriting where the last one was left.
                .id(index)
                .transition(.opacity)
            names
            Text("Every image has to get past us first.")
                .font(Theme.display(19, weight: .semibold, relativeTo: .title3))
                .foregroundStyle(Theme.text)
            Text("Each result is checked against your original before you see it. If it changed the house, you never get it — it is rerun or refused, and your credits come back.")
                .font(Theme.ui(14)).foregroundStyle(Theme.textSoft)
            Text("Credits, never a subscription. They never expire.")
                .font(Theme.ui(13)).foregroundStyle(Theme.textFaint)
        }
        .task {
            while advancing, !Task.isCancelled {
                try? await Task.sleep(for: Self.dwell)
                guard advancing, !Task.isCancelled else { return }
                withAnimation(.easeInOut(duration: 0.45)) { index = (index + 1) % Self.show.count }
            }
        }
    }

    /// The four names, the showing one lit. Tapping one goes straight there
    /// and hands the wheel over.
    private var names: some View {
        HStack(spacing: 5) {
            ForEach(Array(Self.show.enumerated()), id: \.offset) { i, item in
                let on = i == index
                Button {
                    advancing = false
                    withAnimation(.easeInOut(duration: 0.3)) { index = i }
                } label: {
                    Text(item.label)
                        .font(Theme.ui(11.5, weight: on ? .semibold : .regular))
                        .foregroundStyle(on ? Theme.onPine : Theme.textSoft)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                        .padding(.horizontal, 5).padding(.vertical, 6)
                        .frame(maxWidth: .infinity)
                        .background {
                            // The showing one wears the brand gradient, as the
                            // wordmark's "LAB" does (Kyle, 11 Sep 2026).
                            if on { Capsule().fill(Theme.brandGradient) }
                            else { Capsule().fill(Theme.surface2) }
                        }
                        .overlay(Capsule().stroke(on ? Color.clear : Theme.line, lineWidth: 1))
                }
                .buttonStyle(.plain)
            }
        }
    }
}
