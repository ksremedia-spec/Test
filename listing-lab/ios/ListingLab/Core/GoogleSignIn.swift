import Foundation
import CryptoKit

/// Google sign-in from the app (10 Sep 2026). It is the website's own Google
/// flow, shown in a sheet over the app: `GET /api/auth/google?platform=ios
/// &challenge=…` walks Google's sign-in page and lands on `/signin/return`,
/// a page that opens `listinglab://signin?code=…` (or `?error=…`). The app
/// then swaps the code for a session at `POST /api/auth/google/exchange`,
/// presenting the secret behind the challenge (PKCE, RFC 7636) — so a code
/// is useless to anything that did not start the sign-in.
enum GoogleSignIn {
    /// The host of the return link: `listinglab://signin`.
    static let host = "signin"

    /// 32 random bytes as base64url — 43 characters, the secret the app keeps.
    static func makeVerifier() -> String {
        base64url(Data((0..<32).map { _ in UInt8.random(in: .min ... .max) }))
    }

    /// base64url(SHA-256(verifier)), as RFC 7636 spells it.
    static func challenge(for verifier: String) -> String {
        base64url(Data(SHA256.hash(data: Data(verifier.utf8))))
    }

    /// The page the sheet opens.
    static func startURL(challenge: String) -> URL {
        var components = URLComponents(url: APIClient.baseURL, resolvingAgainstBaseURL: false)!
        components.path = "/api/auth/google"
        components.queryItems = [URLQueryItem(name: "platform", value: "ios"), URLQueryItem(name: "challenge", value: challenge)]
        return components.url!
    }

    enum Outcome: Equatable { case code(String), error(String) }

    /// Reads `listinglab://signin?code=…` or `?error=…`. Anything else is not this.
    static func outcome(from url: URL) -> Outcome? {
        guard url.scheme?.lowercased() == CheckoutReturn.scheme, url.host?.lowercased() == host else { return nil }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        if let code = items.first(where: { $0.name == "code" })?.value, !code.isEmpty { return .code(code) }
        let error = items.first(where: { $0.name == "error" })?.value ?? ""
        return .error(error.isEmpty ? "google_denied" : error)
    }

    /// The web's two sentences for a Google sign-in that bounced.
    static func message(forError code: String) -> String {
        code == "google_password_account"
            ? "That email already has a password account — sign in with your password."
            : "Google sign-in didn't finish — try again, or use email and password."
    }

    private static func base64url(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

/// One sign-in in progress: the page to show, and the secret to keep until it returns.
struct GoogleSignInFlow: Identifiable {
    let id = UUID()
    let url: URL
    let verifier: String

    init(verifier: String = GoogleSignIn.makeVerifier()) {
        self.verifier = verifier
        url = GoogleSignIn.startURL(challenge: GoogleSignIn.challenge(for: verifier))
    }
}
