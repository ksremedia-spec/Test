import Foundation

/// Prose the interpretation layer produced for one week's plan.
struct Narration: Codable, Sendable {
    /// One sentence answering "how am I doing?".
    var headline: String
    /// Two or three sentences of context.
    var positioning: String
    /// Rewritten one-line summaries, keyed by recommendation ID. Any ID the
    /// narrator does not return keeps the engine's own wording.
    var moveSummaries: [String: String]
    /// What explicitly does not need attention this week.
    var restingEasy: String

    init(
        headline: String,
        positioning: String,
        moveSummaries: [String: String] = [:],
        restingEasy: String
    ) {
        self.headline = headline
        self.positioning = positioning
        self.moveSummaries = moveSummaries
        self.restingEasy = restingEasy
    }
}

/// Turns verified evidence into readable prose.
///
/// Two implementations ship: a deterministic writer that runs on device at zero
/// cost, and an optional remote one that calls a language model through a backend
/// the user runs. The app is fully functional with the first; the second is an
/// upgrade, never a dependency.
protocol NarrationProvider: Sendable {
    var identifier: String { get }
    /// True when this narrator costs money or network to call, which the caching
    /// layer uses to decide how hard to avoid calling it.
    var isRemote: Bool { get }

    func narrate(_ pack: EvidencePack) async throws -> Narration
}

enum NarrationError: LocalizedError {
    case notConfigured
    case requestFailed(String)
    case invalidResponse
    case rejectedByValidator(String)

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "No analysis endpoint is configured."
        case .requestFailed(let detail):
            return "The analysis service didn't respond: \(detail)"
        case .invalidResponse:
            return "The analysis service returned something unexpected."
        case .rejectedByValidator(let detail):
            return "The generated explanation was rejected: \(detail)"
        }
    }
}
