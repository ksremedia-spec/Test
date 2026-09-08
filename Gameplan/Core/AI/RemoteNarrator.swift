import Foundation

/// Sends the evidence pack to a backend the user runs, which in turn calls a
/// language model.
///
/// The app holds no model API key and never will: an API key shipped inside an
/// iOS binary is readable by anyone who downloads it. The user points the app at
/// their own endpoint, optionally with a bearer token, and that endpoint owns the
/// model credentials.
///
/// Whatever comes back is validated against the evidence before it is shown. A
/// response that fails validation is discarded and the on-device narrator's
/// wording is used instead — a slightly plainer sentence is always better than a
/// confident invented one.
struct RemoteNarrator: NarrationProvider {
    let identifier = "remote"
    let isRemote = true

    var endpoint: URL
    var token: String?
    var session: URLSession
    var validator: NarrationValidator

    init(
        endpoint: URL,
        token: String?,
        session: URLSession = .shared,
        validator: NarrationValidator = NarrationValidator()
    ) {
        self.endpoint = endpoint
        self.token = token
        self.session = session
        self.validator = validator
    }

    func narrate(_ pack: EvidencePack) async throws -> Narration {
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token, !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        request.timeoutInterval = 30

        let body = RequestBody(
            systemPrompt: NarrationPrompt.system,
            userMessage: try NarrationPrompt.userMessage(for: pack),
            evidence: pack
        )
        request.httpBody = try JSONEncoder().encode(body)

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw NarrationError.requestFailed(error.localizedDescription)
        }

        guard let http = response as? HTTPURLResponse else {
            throw NarrationError.invalidResponse
        }
        guard (200...299).contains(http.statusCode) else {
            throw NarrationError.requestFailed("status \(http.statusCode)")
        }

        let narration = try decodeNarration(from: data)

        let result = validator.validate(narration, against: pack)
        guard result.isAcceptable else {
            AppLog.analysis.notice("Rejected remote narration: \(result.reason ?? "unknown", privacy: .public)")
            throw NarrationError.rejectedByValidator(result.reason ?? "unsupported figures")
        }
        return narration
    }

    /// Accepts either a bare narration object or one wrapped in a `narration`
    /// key, so a simple proxy and a richer one both work.
    private func decodeNarration(from data: Data) throws -> Narration {
        let decoder = JSONDecoder()
        if let narration = try? decoder.decode(Narration.self, from: data) {
            return narration
        }
        if let wrapper = try? decoder.decode(Wrapper.self, from: data) {
            return wrapper.narration
        }
        throw NarrationError.invalidResponse
    }

    private struct Wrapper: Decodable {
        var narration: Narration
    }

    private struct RequestBody: Encodable {
        var systemPrompt: String
        var userMessage: String
        var evidence: EvidencePack
    }
}
