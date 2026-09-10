import Foundation
import SwiftUI
import UIKit
import WidgetKit

/// The signed-in state the whole app shares: who is signed in, their
/// balance and the server's prices, the job list, and the toast. One object,
/// on the main actor, handed down through the environment.
@MainActor
@Observable
final class AppSession {
    enum Phase { case loading, signedOut, signedIn }

    var phase: Phase = .loading
    var account: Account?
    /// nil until the first `/api/credits` answer — the chip shows `— credits`.
    var balance: Int?
    /// The server's prices win, always. These are the fallback until it answers.
    var costs: [Transformation: Int] = Dictionary(uniqueKeysWithValues: Transformation.allCases.map { ($0, $0.fallbackCost) })
    var statement: [StatementEntry] = []
    var jobs: [JobSummary] = []
    var jobsLoaded = false

    /// Which tab is showing; the library's "Stage this room" switches to the studio.
    var selectedTab: Tab = .studio
    var showBuyCredits = false
    /// Uploaded originals by photoId, so the run and result screens can show
    /// the local file instead of fetching it — instant, one less round trip.
    var localPreviews: [String: UIImage] = [:]

    let api = APIClient()
    let toasts = ToastCenter()
    let flow = StudioFlow()
    /// Set when Stripe sends the person back into the app; the buy sheet acts on it.
    var checkoutReturn: CheckoutReturn.Status?

    /// `GET /api/auth/config` said `google: true` — show the button, as the web does.
    var googleAvailable = false
    /// A Google sign-in in progress: the sheet the sign-in screen shows, and the secret it keeps.
    var googleSignIn: GoogleSignInFlow?
    /// True while the code is being swapped for a session, after the sheet has closed.
    var googleExchanging = false
    /// What the sign-in screen should show when a Google sign-in bounced; it clears this once shown.
    var googleSignInError: String?

    init() {
        Task { await api.setSessionLostHandler { [weak self] in await self?.sessionLost() } }
        Push.shared.onToken = { [weak self] in Task { await self?.sendDeviceToken() } }
        Push.shared.onOpen = { [weak self] jobId in self?.openFromNotification(jobId) }
    }

    // MARK: - Boot and sessions

    /// Launch: `GET /api/me` with the stored token. 200 → the studio; 401 → sign-in.
    func boot() async {
        guard let token = Keychain.load() else { phase = .signedOut; return }
        await api.setToken(token)
        do {
            let me: AccountResponse = try await api.get("/api/me", allow401: true)
            account = me.account
            phase = .signedIn
            await refreshCredits()
            await refreshJobs()
            await Push.shared.registerIfAllowed()
            await sendDeviceToken()
        } catch APIError.server(let status, _, _) where status == 401 {
            await sessionLost()
        } catch {
            // No signal: keep the session and let the screens report as they go.
            phase = .signedIn
        }
    }

    func signIn(email: String, password: String) async throws {
        let (account, token) = try await api.postForSession("/api/signin", ["email": email, "password": password])
        await enter(account: account, token: token)
    }

    func signUp(email: String, password: String) async throws {
        let (account, token) = try await api.postForSession("/api/signup", ["email": email, "password": password])
        await enter(account: account, token: token)
    }

    struct AppleSignInBody: Encodable {
        struct Name: Encodable { let givenName: String?; let familyName: String? }
        struct User: Encodable { let email: String?; let name: Name }
        let identityToken: String
        let authorizationCode: String?
        let user: User?
    }

    func signInWithApple(identityToken: String, authorizationCode: String?, email: String?, givenName: String?, familyName: String?) async throws {
        let user = (email != nil || givenName != nil || familyName != nil)
            ? AppleSignInBody.User(email: email, name: .init(givenName: givenName, familyName: familyName)) : nil
        let body = AppleSignInBody(identityToken: identityToken, authorizationCode: authorizationCode, user: user)
        let res: AppleSignInResponse = try await api.post("/api/auth/apple", body, allow401: true)
        await enter(account: res.account, token: res.session)
    }

    /// The Google button appears only when the server says the OAuth client is configured, as on the web.
    func checkGoogleAvailable() async {
        guard let config: AuthConfig = try? await api.get("/api/auth/config") else { return }
        googleAvailable = config.google
    }

    /// Opens the website's Google sign-in in a sheet over the app; `handle(url:)` finishes it.
    func startGoogleSignIn() {
        googleSignInError = nil
        googleSignIn = GoogleSignInFlow()
    }

    /// `listinglab://signin?code=…` or `?error=…` arrived: close the sheet,
    /// then swap the code for a session with the secret only this app holds.
    func finishGoogleSignIn(_ outcome: GoogleSignIn.Outcome) async {
        guard let flow = googleSignIn else { return }   // the sheet was already closed by hand
        googleSignIn = nil
        switch outcome {
        case .error(let code):
            googleSignInError = GoogleSignIn.message(forError: code)
        case .code(let code):
            googleExchanging = true
            defer { googleExchanging = false }
            do {
                let res: GoogleSignInResponse = try await api.post("/api/auth/google/exchange",
                                                                   ["code": code, "verifier": flow.verifier], allow401: true)
                await enter(account: res.account, token: res.session)
            } catch let e as APIError {
                googleSignInError = e.message
            } catch {
                googleSignInError = "Something went wrong."
            }
        }
    }

    private func enter(account: Account, token: String) async {
        Keychain.save(token)
        await api.setToken(token)
        self.account = account
        phase = .signedIn
        await refreshCredits()
        await refreshJobs()
        await Push.shared.registerIfAllowed()
        await sendDeviceToken()
    }

    func signOut() async {
        // This phone stops hearing about this account's photos first.
        if let token = Push.shared.token {
            let _: OkResponse? = try? await api.delete("/api/devices/\(token)")
        }
        let _: OkResponse? = try? await api.post("/api/signout", [String: String]())
        await forget()
    }

    // MARK: - Push notifications

    /// Apple's token for this phone goes to the server, which sends one line
    /// when a job finishes. Sent whenever it is known and someone is signed in.
    func sendDeviceToken() async {
        guard phase == .signedIn, let token = Push.shared.token else { return }
        let _: OkResponse? = try? await api.post("/api/devices", ["token": token, "environment": Push.environment])
    }

    /// A job just started: the first time, ask to send notifications — the moment it has a point.
    func jobStarted() {
        Haptics.tap()
        Task { await Push.shared.askIfNeeded() }
    }

    /// A notification was tapped: My photos, freshly read.
    func openFromNotification(_ jobId: String?) {
        selectedTab = .library
        Task { await refreshJobs() }
    }

    /// Any 401 from a signed-in endpoint: the session is gone.
    func sessionLost() async {
        await forget()
    }

    private func forget() async {
        Keychain.clear()
        await api.setToken(nil)
        account = nil
        balance = nil
        statement = []
        jobs = []
        jobsLoaded = false
        localPreviews = [:]
        flow.reset()
        selectedTab = .studio
        showBuyCredits = false
        googleSignIn = nil
        googleSignInError = nil
        previewPrefetch?.cancel()
        prefetchedPaths = []
        widgetLatest = nil
        JobActivity.endAll()
        SharedStore.clear()
        WidgetCenter.shared.reloadAllTimelines()
        phase = .signedOut
    }

    /// `DELETE /api/me`, then the local sign-out (the server already killed every session).
    func deleteAccount() async throws {
        let _: OkResponse = try await api.delete("/api/me")
        await forget()
    }

    // MARK: - Credits and jobs

    func refreshCredits() async {
        guard let c: CreditsResponse = try? await api.get("/api/credits") else { return }
        balance = c.balance
        statement = c.statement
        for t in Transformation.allCases {
            if let v = c.costs[t.rawValue] { costs[t] = v }
        }
    }

    func cost(_ t: Transformation) -> Int { costs[t] ?? t.fallbackCost }

    /// `GET /api/jobs`. A failed fetch leaves the previous list on screen.
    func refreshJobs() async {
        guard let r: JobsResponse = try? await api.get("/api/jobs") else { return }
        jobs = r.jobs
        jobsLoaded = true
        prefetchPreviews()
        JobActivity.reconcile(with: jobs)
        updateWidget()
    }

    private var widgetLatest: String?

    /// The Home Screen widget: the latest finished photo and the counts,
    /// handed over through the shared folder, refreshed whenever the list changes.
    private func updateWidget() {
        let working = jobs.filter { $0.jobStatus.isWorking }.count
        let ready = jobs.filter { $0.jobStatus == .delivered }.count
        let latest = jobs.first { $0.jobStatus == .delivered }
        let api = api
        Task(priority: .utility) {
            var image: Data? = nil
            if let latest, let path = latest.thumbnailUrl, path != widgetLatest {
                image = try? await api.imageData(path)
                if image != nil { widgetLatest = path }
            }
            SharedStore.write(.init(working: working, ready: ready, latestLabel: latest?.kind?.label,
                                    latestAt: ISO.date(latest?.finishedAt), hasLatestImage: latest != nil),
                              latestImage: image)
            WidgetCenter.shared.reloadAllTimelines()
        }
    }

    /// The lock-screen card's own push token, so the server can flip it to
    /// "Ready" while the app is closed.
    func sendActivityToken(jobId: String, token: String) async {
        guard phase == .signedIn else { return }
        let _: OkResponse? = try? await api.post("/api/devices/activity",
                                                 ["jobId": jobId, "token": token, "environment": Push.environment])
    }

    private var previewPrefetch: Task<Void, Never>?
    private var prefetchedPaths: [String] = []

    /// Downloads the grid's previews quietly in the background as soon as the
    /// job list is known — at sign-in, at launch, and whenever the list
    /// changes — newest first, three at a time, so My photos opens with its
    /// pictures already there instead of pulling sixty full-size photos while
    /// the person watches (Kyle, 10 Sep 2026). Anything already downloaded
    /// is skipped; the grid and this never fetch the same photo twice.
    private func prefetchPreviews() {
        let paths = jobs.compactMap(\.thumbnailUrl)
        // The list is re-read every 6 s while something is working; only
        // start over when a preview appeared or disappeared.
        guard paths != prefetchedPaths else { return }
        prefetchedPaths = paths
        previewPrefetch?.cancel()
        let api = api
        previewPrefetch = Task(priority: .utility) {
            var pending: [String] = []
            for path in paths where await !api.hasImage(path) { pending.append(path) }
            await withTaskGroup(of: Void.self) { group in
                var next = pending.makeIterator()
                for _ in 0..<3 {
                    guard let path = next.next() else { break }
                    group.addTask { _ = try? await api.imageData(path) }
                }
                for await _ in group {
                    guard !Task.isCancelled, let path = next.next() else { continue }
                    group.addTask { _ = try? await api.imageData(path) }
                }
            }
        }
    }

    var hasWorkingJobs: Bool { jobs.contains { $0.jobStatus.isWorking } }

    /// What the app does when it comes back to the foreground: the job list
    /// and balance may have moved on (a purchase finished in Safari, say).
    func foregroundRefresh() async {
        guard phase == .signedIn else { return }
        await refreshJobs()
        await refreshCredits()
    }

    /// `listinglab://purchase?status=…` — the return from the website's checkout —
    /// or `listinglab://signin?code=…` — the return from Google sign-in.
    func handle(url: URL) {
        if let status = CheckoutReturn.status(from: url) { checkoutReturn = status }
        if let outcome = GoogleSignIn.outcome(from: url) { Task { await finishGoogleSignIn(outcome) } }
    }
}

/// The single toast, bottom-centre, 3.2 seconds. Newer text replaces the current one.
@MainActor
@Observable
final class ToastCenter {
    var message: String?
    private var hide: Task<Void, Never>?

    func show(_ text: String) {
        message = text
        hide?.cancel()
        hide = Task {
            try? await Task.sleep(for: .seconds(3.2))
            if !Task.isCancelled { message = nil }
        }
    }
}
