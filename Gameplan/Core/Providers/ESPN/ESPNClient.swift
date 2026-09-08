import Foundation

/// Performs authenticated reads against ESPN and decodes them.
///
/// Credentials are read from `SecureStore` on every request rather than being
/// held in memory, and are never logged — the logging here deliberately records
/// only the status code and the view names.
actor ESPNClient {
    private let session: URLSession
    private let secureStore: SecureStore
    private let decoder: JSONDecoder

    init(secureStore: SecureStore, session: URLSession? = nil) {
        self.secureStore = secureStore
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.timeoutIntervalForRequest = 20
            configuration.timeoutIntervalForResource = 40
            configuration.waitsForConnectivity = true
            // Cookies are attached explicitly per request so nothing is retained
            // between launches.
            configuration.httpCookieAcceptPolicy = .never
            configuration.httpShouldSetCookies = false
            self.session = URLSession(configuration: configuration)
        }
        self.decoder = JSONDecoder()
    }

    var hasCredentials: Bool {
        let s2 = secureStore.string(for: .espnS2)?.isEmpty == false
        let swid = secureStore.string(for: .espnSWID)?.isEmpty == false
        return s2 && swid
    }

    func get<T: Decodable>(_ type: T.Type, from url: URL, describing description: String) async throws -> T {
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        if let s2 = secureStore.string(for: .espnS2),
           let swid = secureStore.string(for: .espnSWID),
           !s2.isEmpty, !swid.isEmpty {
            request.setValue("espn_s2=\(s2); SWID=\(normalizeSWID(swid))", forHTTPHeaderField: "Cookie")
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch let error as URLError {
            throw FantasyDataError.network(error.localizedDescription)
        }

        guard let http = response as? HTTPURLResponse else {
            throw FantasyDataError.network("No response from ESPN.")
        }

        AppLog.network.debug("ESPN \(description, privacy: .public) -> \(http.statusCode, privacy: .public)")

        switch http.statusCode {
        case 200...299:
            break
        case 401:
            throw FantasyDataError.authenticationFailed
        case 403:
            // ESPN returns 403 for private leagues read without valid cookies.
            throw hasCredentials ? FantasyDataError.authenticationFailed : FantasyDataError.authenticationRequired
        case 404:
            throw FantasyDataError.leagueNotFound(url.lastPathComponent)
        case 429:
            throw FantasyDataError.rateLimited
        default:
            throw FantasyDataError.network("ESPN returned status \(http.statusCode).")
        }

        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            AppLog.network.error("ESPN decode failure for \(description, privacy: .public)")
            throw FantasyDataError.decoding(description)
        }
    }

    /// ESPN expects the SWID wrapped in braces. Users copy it both ways, so
    /// normalise rather than making them get it exactly right.
    private func normalizeSWID(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("{") && trimmed.hasSuffix("}") { return trimmed }
        return "{\(trimmed)}"
    }
}
