import Foundation
import Security

/// The owner secret — the same `s=` value the board pages take. It is typed
/// once on first launch and kept in the iPhone's Keychain, never in the
/// source code, so the project can live anywhere without leaking it.
enum Secret {
    static let site = "https://thelistinglab.app"
    private static let service = "app.thelistinglab.owner"
    private static let account = "board-secret"

    static func load() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let s = String(data: data, encoding: .utf8), !s.isEmpty else { return nil }
        return s
    }

    static func save(_ value: String) {
        let data = Data(value.utf8)
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(base as CFDictionary)
        var add = base
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(add as CFDictionary, nil)
    }

    static func clear() {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(base as CFDictionary)
    }

    /// Checks a secret against the site before saving it: the live feed
    /// answers 200 to the right secret and 404 to anything else.
    static func verify(_ value: String) async -> Bool {
        guard var comps = URLComponents(string: site + "/internal/board/live.json") else { return false }
        comps.queryItems = [URLQueryItem(name: "s", value: value)]
        guard let url = comps.url else { return false }
        do {
            let (_, resp) = try await URLSession.shared.data(from: url)
            return (resp as? HTTPURLResponse)?.statusCode == 200
        } catch { return false }
    }

    /// A board page URL with the secret attached.
    static func url(_ path: String, secret: String) -> URL {
        var comps = URLComponents(string: site + path)!
        comps.queryItems = [URLQueryItem(name: "s", value: secret)]
        return comps.url!
    }
}
