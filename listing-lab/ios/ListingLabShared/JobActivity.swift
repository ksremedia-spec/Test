import Foundation
import ActivityKit

/// The lock-screen and Dynamic Island card for a job in progress (10 Sep
/// 2026). Shared by the app, which starts and updates it, and the widget
/// extension, which draws it. The server can update it too, with a push:
/// its `content-state` must carry exactly these keys, so dates travel as
/// plain seconds.
struct JobActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        /// `working`, `delivered`, or `returned` (nothing delivered, credits back).
        var status: String
        /// Attempt number, 1-based; the clock restarts on a new take.
        var take: Int
        /// When this take started, as seconds since 1970.
        var startedAtUnix: Double
        var waitingOnUpstream: Bool

        var startedAt: Date { Date(timeIntervalSince1970: startedAtUnix) }
    }

    let jobId: String
    /// The customer label: Declutter, Empty Room, Virtual Staging, Twilight.
    let label: String
}

/// What the Home Screen widget shows, handed over through the App Group:
/// the latest finished photo and the counts.
enum SharedStore {
    static let group = "group.com.horizonhomemedia.listinglab"

    struct Snapshot: Codable {
        var working: Int
        var ready: Int
        var latestLabel: String?
        var latestAt: Date?
        var hasLatestImage: Bool
    }

    static var containerURL: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
    }
    private static var snapshotURL: URL? { containerURL?.appendingPathComponent("widget.json") }
    static var latestImageURL: URL? { containerURL?.appendingPathComponent("latest.jpg") }

    static func write(_ snapshot: Snapshot, latestImage: Data?) {
        guard let snapshotURL, let latestImageURL else { return }
        if let latestImage {
            try? latestImage.write(to: latestImageURL, options: .atomic)
        } else if !snapshot.hasLatestImage {
            try? FileManager.default.removeItem(at: latestImageURL)
        }
        if let data = try? JSONEncoder().encode(snapshot) {
            try? data.write(to: snapshotURL, options: .atomic)
        }
    }

    static func read() -> Snapshot? {
        guard let snapshotURL, let data = try? Data(contentsOf: snapshotURL) else { return nil }
        return try? JSONDecoder().decode(Snapshot.self, from: data)
    }

    static func clear() {
        guard let snapshotURL, let latestImageURL else { return }
        try? FileManager.default.removeItem(at: snapshotURL)
        try? FileManager.default.removeItem(at: latestImageURL)
    }
}
