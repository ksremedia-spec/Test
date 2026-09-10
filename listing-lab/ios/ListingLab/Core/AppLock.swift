import SwiftUI
import UIKit
import LocalAuthentication

/// Face ID (10 Sep 2026). With the switch on, the app locks whenever it goes
/// to the background and asks for Face ID — or Touch ID, or the passcode —
/// to come back. Off by default; the setting lives on this phone only.
@MainActor
@Observable
final class AppLock {
    private static let key = "lockWithBiometrics"

    var enabled: Bool { didSet { UserDefaults.standard.set(enabled, forKey: Self.key) } }
    var locked = false
    var unlocking = false
    var error: String?

    init() {
        enabled = UserDefaults.standard.bool(forKey: Self.key)
        locked = enabled
    }

    /// "Face ID" or "Touch ID" — whichever this phone has; nil when neither is set up.
    static var biometryName: String? {
        let context = LAContext()
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil) else { return nil }
        switch context.biometryType {
        case .faceID: return "Face ID"
        case .touchID: return "Touch ID"
        default: return nil
        }
    }

    func lockIfEnabled() {
        if enabled { locked = true; error = nil }
    }

    /// The system prompt: Face ID, with the passcode as the fallback Apple
    /// offers inside it. A phone with Face ID but no passcode (the simulator,
    /// in practice) gets Face ID alone.
    private static func authenticate(_ reason: String) async throws -> Bool {
        do {
            return try await LAContext().evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)
        } catch let e as LAError where e.code == .passcodeNotSet {
            return try await LAContext().evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason)
        }
    }

    /// Only while the app is in front: iOS refuses the prompt from the
    /// background, and the lock goes on the moment the app leaves the front.
    func unlock() async {
        guard locked, !unlocking, UIApplication.shared.applicationState == .active else { return }
        unlocking = true
        defer { unlocking = false }
        do {
            if try await Self.authenticate("Unlock Listing Lab") {
                locked = false
                error = nil
            }
        } catch let e as LAError where [.userCancel, .systemCancel, .appCancel, .notInteractive].contains(e.code) {
            // Cancelled, or asked at a moment iOS would not show it: stay locked, no red box.
        } catch {
            self.error = "Couldn't unlock — try again."
        }
    }

    /// Turning it on proves the phone can do it first, so the switch never lies.
    func setEnabled(_ on: Bool) async {
        if on {
            let reason = "Unlock Listing Lab with \(Self.biometryName ?? "your passcode")"
            guard (try? await Self.authenticate(reason)) == true else { return }
        }
        enabled = on
    }
}

/// What the app shows while locked: the launch picture, one line, one button.
/// The prompt comes up by itself; the button is for a second try.
struct LockView: View {
    @Environment(AppLock.self) private var lock

    var body: some View {
        ZStack {
            Theme.paper.ignoresSafeArea()
            VStack(spacing: 22) {
                Image("LaunchLockup").resizable().scaledToFit().frame(width: 220, height: 148)
                Text("Listing Lab is locked").font(Theme.ui(15)).foregroundStyle(Theme.textSoft)
                if let error = lock.error { ErrorBox(message: error) }
                Button {
                    Task { await lock.unlock() }
                } label: {
                    if lock.unlocking { ButtonSpinner() } else { Text("Unlock with \(AppLock.biometryName ?? "passcode")") }
                }
                .buttonStyle(PrimaryButtonStyle())
                .frame(maxWidth: 280)
            }
            .padding(24)
        }
        .task { await lock.unlock() }
    }
}
