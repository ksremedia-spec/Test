import Foundation

/// How much a piece of news should change what the user does.
enum NewsImpact: String, Codable, CaseIterable, Comparable, Sendable {
    case informational
    case notable
    case significant

    var displayName: String {
        switch self {
        case .informational: return "FYI"
        case .notable: return "Notable"
        case .significant: return "Significant"
        }
    }

    private var rank: Int {
        switch self {
        case .informational: return 0
        case .notable: return 1
        case .significant: return 2
        }
    }

    static func < (lhs: NewsImpact, rhs: NewsImpact) -> Bool { lhs.rank < rhs.rank }
}

/// A single piece of reported news attached to one or more players.
struct NewsItem: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var headline: String
    var body: String?
    var publishedAt: Date
    var sourceName: String
    var playerIDs: [PlayerID]
    var impact: NewsImpact

    init(
        id: String,
        headline: String,
        body: String? = nil,
        publishedAt: Date,
        sourceName: String,
        playerIDs: [PlayerID] = [],
        impact: NewsImpact = .informational
    ) {
        self.id = id
        self.headline = headline
        self.body = body
        self.publishedAt = publishedAt
        self.sourceName = sourceName
        self.playerIDs = playerIDs
        self.impact = impact
    }

    func isRecent(relativeTo now: Date = Date(), within seconds: TimeInterval = 72 * 3600) -> Bool {
        now.timeIntervalSince(publishedAt) <= seconds
    }
}
