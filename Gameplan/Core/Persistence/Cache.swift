import Foundation

/// A time-limited key/value store for `Codable` values.
protocol Cache: AnyObject, Sendable {
    func value<T: Codable>(forKey key: String, as type: T.Type) async -> T?
    func store<T: Codable>(_ value: T, forKey key: String, lifetime: TimeInterval) async
    func removeValue(forKey key: String) async
    func removeAll() async
}

/// Wraps a cached value with the metadata needed to expire it.
private struct CacheEnvelope<T: Codable>: Codable {
    var storedAt: Date
    var lifetime: TimeInterval
    var value: T

    var isFresh: Bool { Date().timeIntervalSince(storedAt) < lifetime }
}

/// How long different kinds of data stay useful. Rosters change constantly during
/// the week; league settings essentially never change mid-season.
enum CacheLifetime {
    static let leagueSettings: TimeInterval = 24 * 3600
    static let roster: TimeInterval = 15 * 60
    static let matchup: TimeInterval = 10 * 60
    static let waiverPool: TimeInterval = 30 * 60
    /// An NFL schedule does not move once published.
    static let schedule: TimeInterval = 12 * 3600
    /// Depth charts change weekly at most, and are expensive to fetch.
    static let depthChart: TimeInterval = 12 * 3600
    /// Injury reports move through the week, so this is deliberately short.
    static let injuries: TimeInterval = 45 * 60
    static let news: TimeInterval = 15 * 60
    static let weather: TimeInterval = 3 * 3600
    static let analysis: TimeInterval = 6 * 3600
    static let narration: TimeInterval = 24 * 3600
}

/// Disk-backed cache stored in the Caches directory, so the system can reclaim it
/// under storage pressure without breaking the app.
///
/// An in-memory layer sits in front so repeated reads in one session — which is
/// exactly what tab switching produces — never touch the disk.
actor FileCache: Cache {
    private let directory: URL
    private let fileManager: FileManager
    private var memory: [String: Data] = [:]
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(namespace: String = "analysis", fileManager: FileManager = .default) {
        self.fileManager = fileManager
        let base = fileManager.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? fileManager.temporaryDirectory
        self.directory = base.appendingPathComponent("Gameplan/\(namespace)", isDirectory: true)
        encoder.dateEncodingStrategy = .iso8601
        decoder.dateDecodingStrategy = .iso8601
        try? fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    func value<T: Codable>(forKey key: String, as type: T.Type) -> T? {
        guard let data = data(forKey: key) else { return nil }
        guard let envelope = try? decoder.decode(CacheEnvelope<T>.self, from: data) else {
            // A decode failure means the shape changed between builds. Drop it.
            removeValue(forKey: key)
            return nil
        }
        guard envelope.isFresh else {
            removeValue(forKey: key)
            return nil
        }
        return envelope.value
    }

    func store<T: Codable>(_ value: T, forKey key: String, lifetime: TimeInterval) {
        let envelope = CacheEnvelope(storedAt: Date(), lifetime: lifetime, value: value)
        guard let data = try? encoder.encode(envelope) else {
            AppLog.persistence.error("Failed to encode cache entry for key")
            return
        }
        memory[key] = data
        do {
            try data.write(to: url(for: key), options: .atomic)
        } catch {
            AppLog.persistence.error("Failed to write cache entry: \(error.localizedDescription, privacy: .public)")
        }
    }

    func removeValue(forKey key: String) {
        memory[key] = nil
        try? fileManager.removeItem(at: url(for: key))
    }

    func removeAll() {
        memory.removeAll()
        try? fileManager.removeItem(at: directory)
        try? fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    private func data(forKey key: String) -> Data? {
        if let cached = memory[key] { return cached }
        guard let data = try? Data(contentsOf: url(for: key)) else { return nil }
        memory[key] = data
        return data
    }

    private func url(for key: String) -> URL {
        directory.appendingPathComponent(sanitized(key)).appendingPathExtension("json")
    }

    /// Cache keys are built from league and player IDs, which can contain
    /// characters that are not safe in a file name.
    private func sanitized(_ key: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
        let scalars = key.unicodeScalars.map { allowed.contains($0) ? Character($0) : "_" }
        return String(scalars).prefix(120).description
    }
}

/// Cache that forgets everything immediately. Used by tests and previews.
actor NullCache: Cache {
    func value<T: Codable>(forKey key: String, as type: T.Type) -> T? { nil }
    func store<T: Codable>(_ value: T, forKey key: String, lifetime: TimeInterval) {}
    func removeValue(forKey key: String) {}
    func removeAll() {}
}
