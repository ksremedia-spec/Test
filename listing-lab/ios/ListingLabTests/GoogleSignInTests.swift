import XCTest
@testable import ListingLab

/// Google sign-in from the app: the secret and its challenge (checked
/// against RFC 7636's own example), the link that starts it, the link that
/// brings the person back, and the web's wording for a bounce.
final class GoogleSignInTests: XCTestCase {
    func testTheChallengeIsRFC7636s() {
        XCTAssertEqual(GoogleSignIn.challenge(for: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
                       "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }

    func testTheSecretIsFreshAndTheRightShape() {
        let a = GoogleSignIn.makeVerifier(), b = GoogleSignIn.makeVerifier()
        XCTAssertNotEqual(a, b)
        XCTAssertEqual(a.count, 43)
        XCTAssertTrue(a.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }, a)
    }

    func testTheStartLinkNamesTheAppAndItsChallenge() {
        let flow = GoogleSignInFlow(verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        let c = URLComponents(url: flow.url, resolvingAgainstBaseURL: false)!
        XCTAssertEqual(c.scheme, "https")
        XCTAssertEqual(c.host, "thelistinglab.app")
        XCTAssertEqual(c.path, "/api/auth/google")
        XCTAssertEqual(c.queryItems?.first { $0.name == "platform" }?.value, "ios")
        XCTAssertEqual(c.queryItems?.first { $0.name == "challenge" }?.value, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }

    func testTheReturnLinkCarriesACodeOrAnError() {
        XCTAssertEqual(GoogleSignIn.outcome(from: URL(string: "listinglab://signin?code=abc123")!), .code("abc123"))
        XCTAssertEqual(GoogleSignIn.outcome(from: URL(string: "listinglab://signin?error=google_password_account")!), .error("google_password_account"))
        XCTAssertEqual(GoogleSignIn.outcome(from: URL(string: "LISTINGLAB://SignIn?code=abc")!), .code("abc"))
        XCTAssertEqual(GoogleSignIn.outcome(from: URL(string: "listinglab://signin")!), .error("google_denied"))
        XCTAssertNil(GoogleSignIn.outcome(from: URL(string: "listinglab://purchase?status=success")!))
        XCTAssertNil(GoogleSignIn.outcome(from: URL(string: "https://thelistinglab.app/signin/return?code=abc")!))
    }

    func testTheBounceWordingIsTheWebs() {
        XCTAssertEqual(GoogleSignIn.message(forError: "google_password_account"),
                       "That email already has a password account — sign in with your password.")
        for code in ["google_denied", "state_mismatch", "google_token", ""] {
            XCTAssertEqual(GoogleSignIn.message(forError: code),
                           "Google sign-in didn't finish — try again, or use email and password.", code)
        }
    }

    func testTheGoogleMarkDrawsAllFourPiecesInsideItsBox() {
        let box = CGRect(x: 0, y: 0, width: 48, height: 48).insetBy(dx: -0.5, dy: -0.5)
        for entry in GoogleMark.paths {
            let bounds = SVGPath.path(entry.d).boundingRect
            XCTAssertFalse(bounds.isEmpty, entry.d)
            XCTAssertTrue(box.contains(bounds), "\(bounds) for \(entry.d)")
            XCTAssertGreaterThan(bounds.width, 10, "each piece is a real slice of the G, not a stray line")
        }
    }
}
