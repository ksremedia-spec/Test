import Foundation
import UIKit

/// UPLOADS THAT DO NOT NEED TO BE WATCHED (Kyle, 11 Sep 2026).
///
/// An ordinary upload belongs to the app: lock the phone or switch to
/// Messages halfway through a batch of twenty and iOS suspends the app, the
/// connection dies, and the photographer standing in a driveway has to come
/// back and start again. That is the single most website-ish thing an app can
/// do, and iOS has an answer: hand the transfer to the system, which carries
/// it on outside the app and wakes the app when it is done.
///
/// The system's API is delegate-based and must upload from a FILE rather than
/// from bytes in memory, so this bridges it back to the plain `await` the rest
/// of the app is written in: one shared session, a continuation per task, and
/// the response body collected as it arrives.
///
/// The stall rule the app already promised is now the system's to keep:
/// `timeoutIntervalForRequest` on a background session is exactly "give up
/// after this long with nothing moving", which is what the hand-rolled
/// watchdog did, minus the timer.
final class BackgroundUploader: NSObject, @unchecked Sendable {
    static let shared = BackgroundUploader()

    static let identifier = "com.horizonhomemedia.listinglab.uploads"

    private let lock = NSLock()
    private var continuations: [Int: CheckedContinuation<(Data, HTTPURLResponse), Error>] = [:]
    private var bodies: [Int: Data] = [:]
    private var progressHandlers: [Int: @Sendable (Int64, Int64) -> Void] = [:]
    private var files: [Int: URL] = [:]

    /// Set by the app delegate when iOS wakes the app to say a transfer
    /// finished while it was not running; called once every event is in.
    private var systemWakeCompletion: (@Sendable () -> Void)?

    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.background(withIdentifier: Self.identifier)
        config.timeoutIntervalForRequest = APIClient.uploadStallTimeout   // nothing moving for this long → give up
        config.timeoutIntervalForResource = 15 * 60
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.sessionSendsLaunchEvents = true
        // Not discretionary: the person is standing there waiting for it.
        config.isDiscretionary = false
        config.allowsCellularAccess = true
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()

    /// Wake the session up early in launch, so transfers finished while the
    /// app was away are delivered rather than waiting for the first upload.
    func reconnect() { _ = session }

    func setSystemWakeCompletion(_ handler: @escaping @Sendable () -> Void) {
        lock.lock(); systemWakeCompletion = handler; lock.unlock()
    }

    /// Upload `data` and wait for the answer. The bytes are written to a file
    /// first because that is what a system-carried transfer reads from; the
    /// file is deleted when the transfer ends, however it ends.
    func upload(_ data: Data, request: URLRequest,
                progress: @escaping @Sendable (Int64, Int64) -> Void) async throws -> (Data, HTTPURLResponse) {
        let file = FileManager.default.temporaryDirectory
            .appendingPathComponent("upload-\(UUID().uuidString)")
        try data.write(to: file, options: .atomic)

        return try await withCheckedThrowingContinuation { continuation in
            let task = session.uploadTask(with: request, fromFile: file)
            lock.lock()
            continuations[task.taskIdentifier] = continuation
            progressHandlers[task.taskIdentifier] = progress
            files[task.taskIdentifier] = file
            lock.unlock()
            task.resume()
        }
    }

    private func finish(_ id: Int, with result: Result<(Data, HTTPURLResponse), Error>) {
        lock.lock()
        let continuation = continuations.removeValue(forKey: id)
        let file = files.removeValue(forKey: id)
        bodies[id] = nil
        progressHandlers[id] = nil
        lock.unlock()
        if let file { try? FileManager.default.removeItem(at: file) }
        switch result {
        case .success(let value): continuation?.resume(returning: value)
        case .failure(let error): continuation?.resume(throwing: error)
        }
    }
}

extension BackgroundUploader: URLSessionDataDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
                    totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        lock.lock()
        let handler = progressHandlers[task.taskIdentifier]
        lock.unlock()
        handler?(totalBytesSent, totalBytesExpectedToSend)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock()
        bodies[dataTask.taskIdentifier, default: Data()].append(data)
        lock.unlock()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock()
        let body = bodies[task.taskIdentifier] ?? Data()
        lock.unlock()
        if let error {
            finish(task.taskIdentifier, with: .failure(error))
        } else if let http = task.response as? HTTPURLResponse {
            finish(task.taskIdentifier, with: .success((body, http)))
        } else {
            finish(task.taskIdentifier, with: .failure(URLError(.badServerResponse)))
        }
    }

    /// Every event from a transfer that finished while the app was away has
    /// now been delivered; iOS wants to know so it can suspend the app again.
    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        lock.lock()
        let handler = systemWakeCompletion
        systemWakeCompletion = nil
        lock.unlock()
        if let handler { DispatchQueue.main.async { handler() } }
    }
}
