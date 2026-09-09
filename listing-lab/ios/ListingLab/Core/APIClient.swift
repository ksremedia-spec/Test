import Foundation
import UIKit

/// Everything that can go wrong talking to the server, with the sentence the
/// web app shows for it. `message` is always safe to show.
enum APIError: Error, Equatable {
    /// The server answered with its error shape. `message` is customer-safe.
    case server(status: Int, code: String, message: String)
    /// The request took longer than 45 seconds.
    case timeout
    /// The connection dropped or never opened.
    case network
    /// A 401 on a signed-in endpoint: the session is gone.
    case notSignedIn
    /// The server answered 2xx with something we could not read.
    case decoding
    /// Uploads only: 60 seconds without a single progress event.
    case uploadStalled
    case uploadNetwork
    case uploadFailed(status: Int)

    var message: String {
        switch self {
        case .server(_, _, let message): return message
        case .timeout: return "That took too long — check your signal and try again."
        case .network: return "Connection problem — check your signal and try again."
        case .notSignedIn: return "Sign in to continue."
        case .decoding: return "Something went wrong."
        case .uploadStalled: return "That upload stalled — check your signal and try again."
        case .uploadNetwork: return "Network hiccup — check your connection and try again."
        case .uploadFailed(let status): return "Upload failed (\(status))"
        }
    }

    var code: String? {
        if case .server(_, let code, _) = self { return code }
        return nil
    }

    /// The web marks timeouts and network drops as retryable.
    var isRetryable: Bool { self == .timeout || self == .network }
}

/// The one door to `https://thelistinglab.app`.
///
/// Sends the session as a `Cookie: ll_session=<token>` header itself — the
/// shared cookie jar is switched off so a stale cookie can never ride along.
/// 45-second request timeout on every JSON call, as on the web; uploads get a
/// 60-second stall timeout that resets on every progress event instead.
actor APIClient {
    static let baseURL = URL(string: "https://thelistinglab.app")!
    static let requestTimeout: TimeInterval = 45
    static let uploadStallTimeout: TimeInterval = 60

    private let session: URLSession
    private var token: String?
    /// Called on any 401 from a signed-in endpoint: the app clears the session and shows sign-in.
    private var onSessionLost: (@Sendable () async -> Void)?
    private let imageCache = NSCache<NSString, NSData>()

    init() {
        let config = URLSessionConfiguration.default
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.timeoutIntervalForRequest = APIClient.requestTimeout
        config.timeoutIntervalForResource = 15 * 60
        config.waitsForConnectivity = false
        // Results are immutable (`cache-control: immutable`); let URLCache keep them.
        config.urlCache = URLCache(memoryCapacity: 64 << 20, diskCapacity: 512 << 20)
        session = URLSession(configuration: config)
        imageCache.totalCostLimit = 128 << 20
    }

    func setToken(_ token: String?) { self.token = token }
    func setSessionLostHandler(_ handler: @escaping @Sendable () async -> Void) { onSessionLost = handler }

    // MARK: - JSON

    func get<T: Decodable>(_ path: String, allow401: Bool = false) async throws -> T {
        try await send("GET", path, body: nil, allow401: allow401).value
    }

    func post<T: Decodable>(_ path: String, _ body: some Encodable, allow401: Bool = false) async throws -> T {
        try await send("POST", path, body: try JSONEncoder().encode(body), allow401: allow401).value
    }

    func delete<T: Decodable>(_ path: String) async throws -> T {
        try await send("DELETE", path, body: nil).value
    }

    /// Sign-in and sign-up: the session arrives as a `Set-Cookie` header.
    func postForSession(_ path: String, _ body: some Encodable) async throws -> (Account, String) {
        let (value, response): (AccountResponse, HTTPURLResponse) =
            try await send("POST", path, body: try JSONEncoder().encode(body), allow401: true)
        guard let token = APIClient.sessionToken(from: response) else { throw APIError.decoding }
        return (value.account, token)
    }

    /// Reads `ll_session` out of a response's Set-Cookie header(s).
    static func sessionToken(from response: HTTPURLResponse) -> String? {
        let fields = response.allHeaderFields.reduce(into: [String: String]()) { out, kv in
            if let k = kv.key as? String, let v = kv.value as? String { out[k] = v }
        }
        let cookies = HTTPCookie.cookies(withResponseHeaderFields: fields, for: response.url ?? baseURL)
        if let c = cookies.first(where: { $0.name == "ll_session" }), !c.value.isEmpty { return c.value }
        return nil
    }

    private func send<T: Decodable>(_ method: String, _ path: String, body: Data?, allow401: Bool = false) async throws -> (value: T, response: HTTPURLResponse) {
        guard let url = URL(string: path, relativeTo: APIClient.baseURL)?.absoluteURL else { throw APIError.network }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = APIClient.requestTimeout
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue("application/json", forHTTPHeaderField: "accept")
        if let token { request.setValue("ll_session=\(token)", forHTTPHeaderField: "Cookie") }
        request.httpBody = body ?? (method == "POST" ? Data("{}".utf8) : nil)

        let data: Data
        let response: HTTPURLResponse
        do {
            let (d, r) = try await session.data(for: request)
            data = d
            guard let http = r as? HTTPURLResponse else { throw APIError.network }
            response = http
        } catch let e as URLError {
            throw e.code == .timedOut ? APIError.timeout : APIError.network
        } catch let e as APIError {
            throw e
        } catch {
            throw APIError.network
        }
        return (try await decode(data, response, allow401: allow401), response)
    }

    private func decode<T: Decodable>(_ data: Data, _ response: HTTPURLResponse, allow401: Bool) async throws -> T {
        if (200..<300).contains(response.statusCode) {
            do { return try JSONDecoder().decode(T.self, from: data) }
            catch { throw APIError.decoding }
        }
        let err = APIClient.serverError(data, status: response.statusCode)
        if response.statusCode == 401, !allow401 {
            // The web reloads to the sign-in form on any 401 elsewhere.
            token = nil
            if let onSessionLost { await onSessionLost() }
            throw APIError.notSignedIn
        }
        throw err
    }

    static func serverError(_ data: Data, status: Int) -> APIError {
        struct Body: Decodable { struct Inner: Decodable { let code: String; let message: String }; let error: Inner }
        if let body = try? JSONDecoder().decode(Body.self, from: data) {
            return .server(status: status, code: body.error.code, message: body.error.message)
        }
        return .server(status: status, code: "HTTP_\(status)", message: "Something went wrong.")
    }

    // MARK: - Images and files

    /// Bytes of `/api/photos/<key>`, with the session attached. Cached: a key is never rewritten.
    func imageData(_ path: String) async throws -> Data {
        if let cached = imageCache.object(forKey: path as NSString) { return cached as Data }
        let data = try await rawGET(path)
        imageCache.setObject(data as NSData, forKey: path as NSString, cost: data.count)
        return data
    }

    /// A file download (the ZIP, or a result for saving). Not cached in memory.
    func fileData(_ path: String) async throws -> Data {
        try await rawGET(path)
    }

    private func rawGET(_ path: String) async throws -> Data {
        guard let url = URL(string: path, relativeTo: APIClient.baseURL)?.absoluteURL else { throw APIError.network }
        var request = URLRequest(url: url)
        request.timeoutInterval = 120
        if let token { request.setValue("ll_session=\(token)", forHTTPHeaderField: "Cookie") }
        do {
            let (data, r) = try await session.data(for: request)
            guard let http = r as? HTTPURLResponse else { throw APIError.network }
            if (200..<300).contains(http.statusCode) { return data }
            if http.statusCode == 401 {
                token = nil
                if let onSessionLost { await onSessionLost() }
                throw APIError.notSignedIn
            }
            throw APIClient.serverError(data, status: http.statusCode)
        } catch let e as URLError {
            throw e.code == .timedOut ? APIError.timeout : APIError.network
        }
    }

    // MARK: - Upload

    /// `POST /api/photos` with the raw bytes. Reports byte progress; aborts
    /// after 60 seconds without progress (the timer re-arms on every event,
    /// so a slow-but-moving upload is never cut off).
    func upload(_ prepared: PreparedImage, progress: @escaping @Sendable (Int64, Int64) -> Void) async throws -> UploadedPhoto {
        var request = URLRequest(url: APIClient.baseURL.appendingPathComponent("api/photos"))
        request.httpMethod = "POST"
        request.timeoutInterval = 15 * 60
        request.setValue(prepared.contentType, forHTTPHeaderField: "content-type")
        if let token { request.setValue("ll_session=\(token)", forHTTPHeaderField: "Cookie") }

        let watchdog = UploadWatchdog()
        let delegate = UploadProgressDelegate { sent, total in
            watchdog.touch()
            progress(sent, total)
        }
        let uploadTask = Task { [session] in
            try await session.upload(for: request, from: prepared.data, delegate: delegate)
        }
        let watchdogTask = Task {
            while !Task.isCancelled {
                try await Task.sleep(for: .seconds(1))
                if watchdog.secondsSinceProgress > APIClient.uploadStallTimeout {
                    watchdog.markStalled()
                    uploadTask.cancel()
                    return
                }
            }
        }
        defer { watchdogTask.cancel() }

        let data: Data
        let response: HTTPURLResponse
        do {
            let (d, r) = try await uploadTask.value
            data = d
            guard let http = r as? HTTPURLResponse else { throw APIError.uploadNetwork }
            response = http
        } catch is CancellationError {
            throw watchdog.stalled ? APIError.uploadStalled : APIError.uploadNetwork
        } catch let e as URLError {
            if watchdog.stalled || e.code == .cancelled { throw APIError.uploadStalled }
            throw APIError.uploadNetwork
        } catch let e as APIError {
            throw e
        } catch {
            throw APIError.uploadNetwork
        }
        if (200..<300).contains(response.statusCode) {
            do { return try JSONDecoder().decode(UploadedPhoto.self, from: data) }
            catch { throw APIError.decoding }
        }
        if response.statusCode == 401 {
            token = nil
            if let onSessionLost { await onSessionLost() }
            throw APIError.notSignedIn
        }
        let err = APIClient.serverError(data, status: response.statusCode)
        if case .server(_, let code, _) = err, code.hasPrefix("HTTP_") { throw APIError.uploadFailed(status: response.statusCode) }
        throw err
    }
}

/// Tracks the last moment an upload made progress. Locked, because URLSession
/// reports progress on its own queue.
final class UploadWatchdog: @unchecked Sendable {
    private let lock = NSLock()
    private var last = Date()
    private var _stalled = false

    func touch() { lock.lock(); last = Date(); lock.unlock() }
    func markStalled() { lock.lock(); _stalled = true; lock.unlock() }
    var stalled: Bool { lock.lock(); defer { lock.unlock() }; return _stalled }
    var secondsSinceProgress: TimeInterval { lock.lock(); defer { lock.unlock() }; return Date().timeIntervalSince(last) }
}

/// Forwards `didSendBodyData` — the one delegate call an upload needs.
final class UploadProgressDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let onProgress: @Sendable (Int64, Int64) -> Void
    init(onProgress: @escaping @Sendable (Int64, Int64) -> Void) { self.onProgress = onProgress }

    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
                    totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        onProgress(totalBytesSent, totalBytesExpectedToSend)
    }
}
