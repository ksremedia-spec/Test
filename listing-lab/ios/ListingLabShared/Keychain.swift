import Foundation
import Security

/// The session token — the value of the `ll_session` cookie — kept in the
/// iPhone's Keychain, never in a file or in UserDefaults. Same helper shape
/// as the owner's back-office app. `AfterFirstUnlock` so a launch in the
/// background (a foreground refresh, a purchase replay) can still read it.
enum Keychain {
    private static let service = "app.thelistinglab.listinglab"
    private static let account = "session"
    /// SHARED WITH THE SHARE EXTENSION (11 Sep 2026). Sending photos straight
    /// from the Photos app means the extension has to sign its own uploads,
    /// and an app group doubles as a keychain access group — so the token
    /// lives in the group rather than in the app alone. No new capability:
    /// the group is the one the widget already uses.
    private static let accessGroup = SharedStore.group

    private static func query(shared: Bool) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if shared { q[kSecAttrAccessGroup as String] = accessGroup }
        return q
    }

    static func load() -> String? {
        if let shared = read(shared: true) { return shared }
        // Signed in before the token moved into the shared group: take it
        // across once, so nobody is signed out by an update.
        if let legacy = read(shared: false) {
            save(legacy)
            SecItemDelete(query(shared: false) as CFDictionary)
            return legacy
        }
        return nil
    }

    private static func read(shared: Bool) -> String? {
        var q = query(shared: shared)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let s = String(data: data, encoding: .utf8), !s.isEmpty else { return nil }
        return s
    }

    static func save(_ value: String) {
        let base = query(shared: true)
        SecItemDelete(base as CFDictionary)
        var add = base
        add[kSecValueData as String] = Data(value.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(add as CFDictionary, nil)
    }

    static func clear() {
        SecItemDelete(query(shared: true) as CFDictionary)
        SecItemDelete(query(shared: false) as CFDictionary)
    }
}
