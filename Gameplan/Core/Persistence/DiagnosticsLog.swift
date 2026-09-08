import Foundation

/// One recorded network exchange.
struct DiagnosticsEntry: Identifiable, Codable, Hashable, Sendable {
    var id: String
    var label: String
    var url: String
    var statusCode: Int?
    var byteCount: Int
    var timestamp: Date
    var outcome: String
    /// The beginning of the response body, capped. Enough to see the shape of
    /// the payload without keeping megabytes of it around.
    var sample: String

    var isFailure: Bool { outcome != "ok" }
}

/// Records what the app actually received from each data source.
///
/// This exists because the data sources here are undocumented. When a field
/// arrives under a different name, or a list turns up empty, the useful thing is
/// not a stack trace — it is the first few hundred characters of what actually
/// came back. This keeps those, so a problem can be diagnosed from the device
/// instead of guessed at.
///
/// It never records request headers, cookies or credentials — only the response
/// body and the status code.
actor DiagnosticsLog {
    static let shared = DiagnosticsLog()

    private var entries: [DiagnosticsEntry] = []
    private let limit = 24
    private let sampleLimit = 1400

    func record(
        label: String,
        url: URL,
        statusCode: Int?,
        data: Data?,
        outcome: String
    ) {
        let body = data.flatMap { String(data: $0.prefix(sampleLimit * 2), encoding: .utf8) } ?? ""
        let entry = DiagnosticsEntry(
            id: UUID().uuidString,
            label: label,
            // Query strings can carry a league ID but never a credential; the
            // cookies live in a header, which is not recorded.
            url: url.absoluteString,
            statusCode: statusCode,
            byteCount: data?.count ?? 0,
            timestamp: Date(),
            outcome: outcome,
            sample: String(body.prefix(sampleLimit))
        )
        entries.insert(entry, at: 0)
        if entries.count > limit { entries.removeLast(entries.count - limit) }
    }

    func all() -> [DiagnosticsEntry] { entries }

    func clear() { entries.removeAll() }

    /// A plain-text report suitable for pasting into a message.
    func report() -> String {
        guard !entries.isEmpty else { return "No requests recorded yet." }
        let formatter = ISO8601DateFormatter()
        return entries.map { entry in
            """
            [\(entry.label)] \(entry.outcome.uppercased())
            when:   \(formatter.string(from: entry.timestamp))
            url:    \(entry.url)
            status: \(entry.statusCode.map(String.init) ?? "—")
            bytes:  \(entry.byteCount)
            body:
            \(entry.sample.isEmpty ? "(empty)" : entry.sample)
            """
        }.joined(separator: "\n\n———\n\n")
    }
}
