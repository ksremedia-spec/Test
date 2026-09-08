import Foundation
import Security

/// Secrets the app may hold on the user's behalf.
///
/// Nothing here is ever compiled into the binary. Every value is supplied by the
/// user at runtime and lives only in the Keychain.
enum SecretKey: String, CaseIterable {
    /// ESPN's `espn_s2` session cookie, required to read a private league.
    case espnS2 = "espn_s2"
    /// ESPN's `SWID` cookie.
    case espnSWID = "espn_swid"
    /// Bearer token for the user's own analysis backend, if they run one.
    case narrationToken = "narration_token"
}

/// Reads and writes small secrets.
protocol SecureStore: AnyObject, Sendable {
    func string(for key: SecretKey) -> String?
    func set(_ value: String?, for key: SecretKey) throws
    func removeAll() throws
}

enum SecureStoreError: LocalizedError {
    case unableToStore(OSStatus)

    var errorDescription: String? {
        switch self {
        case .unableToStore:
            return "Couldn't save that securely on this device."
        }
    }
}

/// Keychain-backed implementation. Items are stored with
/// `kSecAttrAccessibleAfterFirstUnlock` so background refreshes can read them,
/// and are never written to logs or backups in plaintext.
final class KeychainSecureStore: SecureStore, @unchecked Sendable {
    private let service: String
    private let lock = NSLock()

    init(service: String = "com.gameplan.fantasy.secrets") {
        self.service = service
    }

    func string(for key: SecretKey) -> String? {
        lock.lock()
        defer { lock.unlock() }

        var query = baseQuery(for: key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func set(_ value: String?, for key: SecretKey) throws {
        lock.lock()
        defer { lock.unlock() }

        let query = baseQuery(for: key)
        SecItemDelete(query as CFDictionary)

        guard let value, !value.isEmpty else { return }

        var attributes = query
        attributes[kSecValueData as String] = Data(value.utf8)
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock

        let status = SecItemAdd(attributes as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw SecureStoreError.unableToStore(status)
        }
    }

    func removeAll() throws {
        for key in SecretKey.allCases {
            try set(nil, for: key)
        }
    }

    private func baseQuery(for key: SecretKey) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key.rawValue
        ]
    }
}

/// In-memory store used by tests and SwiftUI previews.
final class InMemorySecureStore: SecureStore, @unchecked Sendable {
    private var storage: [SecretKey: String] = [:]
    private let lock = NSLock()

    init(seed: [SecretKey: String] = [:]) {
        storage = seed
    }

    func string(for key: SecretKey) -> String? {
        lock.lock(); defer { lock.unlock() }
        return storage[key]
    }

    func set(_ value: String?, for key: SecretKey) throws {
        lock.lock(); defer { lock.unlock() }
        storage[key] = value
    }

    func removeAll() throws {
        lock.lock(); defer { lock.unlock() }
        storage.removeAll()
    }
}
