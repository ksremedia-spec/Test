import Foundation
import CryptoKit

/// THE LIBRARY, KEPT ON THE PHONE (11 Sep 2026).
///
/// Kyle: "it still feels like something pulling from the website." It did.
/// Every launch started with an empty My photos and a spinner, because the
/// job list and every thumbnail lived only in memory — so a basement, a lift,
/// or one bar of signal meant an empty app, and even on good signal the grid
/// arrived a beat late. A website has no choice about that. An app does.
///
/// So the list and its pictures are written to the phone as they arrive. The
/// app opens from disk, instantly and offline, and the network refresh just
/// updates what is already on screen.
///
/// The list is small and goes in Application Support, which iOS keeps. The
/// pictures are large and go in Caches, which iOS may reclaim when the phone
/// runs out of room — the right trade: a purged thumbnail costs one refetch,
/// and photographs should never be the reason a phone fills up.
enum LocalLibrary {
    /// Start pruning above this, down to `keepBytes`. A 640px preview is
    /// ~70 KB, so this is room for far more than the sixty the server lists.
    static let pruneAboveBytes = 400 << 20
    static let keepBytes = 300 << 20

    // MARK: - Where things live

    private static func directory(_ base: FileManager.SearchPathDirectory, _ name: String) -> URL? {
        guard let root = FileManager.default.urls(for: base, in: .userDomainMask).first else { return nil }
        let dir = root.appendingPathComponent(name, isDirectory: true)
        if !FileManager.default.fileExists(atPath: dir.path) {
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        return dir
    }

    private static var listDirectory: URL? { directory(.applicationSupportDirectory, "ListingLab") }
    private static var imageDirectory: URL? { directory(.cachesDirectory, "ListingLabPhotos") }
    private static var jobsURL: URL? { listDirectory?.appendingPathComponent("jobs.json") }

    /// A server path is not a legal filename, so the file is named by its hash.
    private static func filename(for path: String) -> String {
        SHA256.hash(data: Data(path.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - The job list

    static func saveJobs(_ jobs: [JobSummary]) {
        guard let jobsURL, let data = try? JSONEncoder().encode(jobs) else { return }
        try? data.write(to: jobsURL, options: .atomic)
    }

    static func loadJobs() -> [JobSummary]? {
        guard let jobsURL, let data = try? Data(contentsOf: jobsURL) else { return nil }
        return try? JSONDecoder().decode([JobSummary].self, from: data)
    }

    // MARK: - The pictures

    static func imageData(for path: String) -> Data? {
        guard let url = imageDirectory?.appendingPathComponent(filename(for: path)) else { return nil }
        guard let data = try? Data(contentsOf: url) else { return nil }
        // Touch it, so the prune below treats "recently looked at" as recent.
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: url.path)
        return data
    }

    static func saveImage(_ data: Data, for path: String) {
        guard let url = imageDirectory?.appendingPathComponent(filename(for: path)) else { return }
        try? data.write(to: url, options: .atomic)
    }

    static func hasImage(for path: String) -> Bool {
        guard let url = imageDirectory?.appendingPathComponent(filename(for: path)) else { return false }
        return FileManager.default.fileExists(atPath: url.path)
    }

    /// Oldest-looked-at first, until the folder is back under `keepBytes`.
    /// Cheap enough to call after a refresh; does nothing in the normal case.
    static func pruneImages() {
        guard let dir = imageDirectory else { return }
        let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey]
        guard let files = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: keys) else { return }
        var sized = files.compactMap { url -> (url: URL, size: Int, at: Date)? in
            guard let v = try? url.resourceValues(forKeys: Set(keys)),
                  let size = v.fileSize else { return nil }
            return (url, size, v.contentModificationDate ?? .distantPast)
        }
        var total = sized.reduce(0) { $0 + $1.size }
        guard total > pruneAboveBytes else { return }
        sized.sort { $0.at < $1.at }
        for file in sized {
            guard total > keepBytes else { break }
            try? FileManager.default.removeItem(at: file.url)
            total -= file.size
        }
    }

    /// Signing out takes the library with it — the next person on this phone
    /// must not find the last one's photographs in a cache.
    static func clear() {
        if let jobsURL { try? FileManager.default.removeItem(at: jobsURL) }
        if let dir = imageDirectory { try? FileManager.default.removeItem(at: dir) }
    }
}
