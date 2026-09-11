import Foundation

/// The two requests the share extension makes on its own (11 Sep 2026).
///
/// Sharing photos straight from Photos means the extension uploads and starts
/// the jobs itself, without the app. It cannot use the app's `APIClient` —
/// that lives in the app's own module and is wound through the app's session —
/// so the two calls it needs are written plainly here, in the code both
/// targets share, against the same contract in docs/API.md.
///
/// The upload runs while the sheet is open, and the person watches it. A
/// share sheet is destroyed the moment it is dismissed, so anything still in
/// flight goes with it; that is the honest behaviour for a few seconds of
/// waiting, and it is what the progress line is telling them.
enum ShareAPI {
    static let baseURL = URL(string: "https://thelistinglab.app")!

    enum Failure: Error {
        case notSignedIn
        case message(String)
        case network

        /// Always safe to show; the server's own sentence wherever there is one.
        var text: String {
            switch self {
            case .notSignedIn: return "Sign in to Listing Lab first."
            case .message(let m): return m
            case .network: return "Connection problem — check your signal and try again."
            }
        }
    }

    private static func session() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.timeoutIntervalForRequest = 60
        config.timeoutIntervalForResource = 10 * 60
        return URLSession(configuration: config)
    }

    private static func decodeFailure(_ data: Data, status: Int) -> Failure {
        struct Body: Decodable { struct Inner: Decodable { let code: String; let message: String }; let error: Inner }
        if let body = try? JSONDecoder().decode(Body.self, from: data) { return .message(body.error.message) }
        return .message("Something went wrong.")
    }

    /// `POST /api/photos` — the bytes, answered with the photo's id.
    static func upload(_ prepared: PreparedImage, token: String) async throws -> String {
        var request = URLRequest(url: baseURL.appendingPathComponent("api/photos"))
        request.httpMethod = "POST"
        request.setValue(prepared.contentType, forHTTPHeaderField: "content-type")
        request.setValue("ll_session=\(token)", forHTTPHeaderField: "Cookie")

        let (data, response): (Data, URLResponse)
        do { (data, response) = try await session().upload(for: request, from: prepared.data) }
        catch { throw Failure.network }
        guard let http = response as? HTTPURLResponse else { throw Failure.network }
        guard (200..<300).contains(http.statusCode) else {
            throw http.statusCode == 401 ? Failure.notSignedIn : decodeFailure(data, status: http.statusCode)
        }
        struct Answer: Decodable { let photoId: String }
        guard let answer = try? JSONDecoder().decode(Answer.self, from: data) else { throw Failure.network }
        return answer.photoId
    }

    /// `POST /api/transform` — spend the credits and start the work.
    static func start(photoId: String, transformation: String, style: String?, roomType: String?,
                             token: String) async throws {
        var request = URLRequest(url: baseURL.appendingPathComponent("api/transform"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue("ll_session=\(token)", forHTTPHeaderField: "Cookie")
        var body: [String: String] = ["photoId": photoId, "transformation": transformation]
        if let style { body["style"] = style }
        if let roomType { body["roomType"] = roomType }
        request.httpBody = try? JSONEncoder().encode(body)

        let (data, response): (Data, URLResponse)
        do { (data, response) = try await session().data(for: request) }
        catch { throw Failure.network }
        guard let http = response as? HTTPURLResponse else { throw Failure.network }
        guard (200..<300).contains(http.statusCode) else {
            throw http.statusCode == 401 ? Failure.notSignedIn : decodeFailure(data, status: http.statusCode)
        }
    }
}
