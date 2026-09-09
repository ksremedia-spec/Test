import Foundation
import SwiftUI
import UIKit

/// One uploaded photo while the person chooses what to do with it. A class
/// so the scene poll can narrow its offers under a live row.
@MainActor
@Observable
final class BatchItem: Identifiable {
    enum Fix: Equatable { case none, skip, run(Transformation) }

    let id = UUID()
    let name: String
    let preview: UIImage?
    var photoId: String
    var originalPath: String
    var offers: [Transformation]
    var advice: [Transformation: String]
    var classifying: Bool
    var fix: Fix = .none
    var style: String = Catalog.stagingStyles[0]
    var room: String = Catalog.roomTypes[0]

    init(name: String, preview: UIImage?, photo: UploadedPhoto) {
        self.name = name
        self.preview = preview
        self.photoId = photo.photoId
        self.originalPath = photo.url
        self.offers = BatchItem.transformations(photo.offers)
        self.advice = BatchItem.advice(photo.advice)
        self.classifying = photo.classifying ?? true
    }

    /// A photo that did not come from an upload (a rerun, a chained result).
    init(name: String, preview: UIImage?, photoId: String, originalPath: String, offers: [Transformation]) {
        self.name = name
        self.preview = preview
        self.photoId = photoId
        self.originalPath = originalPath
        self.offers = offers
        self.advice = [:]
        self.classifying = false
    }

    var chosen: Transformation? {
        if case .run(let t) = fix { return t }
        return nil
    }

    /// Offers come from the server in its order; unknown names are dropped.
    static func transformations(_ names: [String]) -> [Transformation] {
        let list = names.compactMap(Transformation.init(rawValue:))
        return list.isEmpty ? Transformation.allCases : list
    }

    static func advice(_ raw: [String: String]?) -> [Transformation: String] {
        var out: [Transformation: String] = [:]
        for (k, v) in raw ?? [:] { if let t = Transformation(rawValue: k) { out[t] = v } }
        return out
    }

    func apply(_ scene: SceneResponse) {
        offers = BatchItem.transformations(scene.offers)
        advice = BatchItem.advice(scene.advice)
        classifying = !scene.ready
    }
}

/// A file the person picked, before it is prepared and uploaded.
struct PickedFile: Sendable {
    let name: String
    let data: Data
}

/// Where the run screen needs to pick up from.
struct RunContext: Hashable {
    let jobId: String
    let transformation: Transformation
    let photoId: String?
    let originalPath: String?
    /// Real start, so a six-minute-old job opens at 6:00, not 0:00.
    let startedAt: Date?
}

/// A finished job, for the result screen.
struct ResultContext: Hashable {
    let jobId: String
    let transformation: Transformation
    let photoId: String?
    let originalPath: String?
    let status: String
    let resultUrl: String?
    let variantUrls: [String]
    let note: String?
    let customerMessage: String?

    var jobStatus: JobStatus { JobStatus(status) }
}

/// The studio's own state: uploads in progress, the photos waiting for a
/// choice, and the navigation path through pick → run → result.
@MainActor
@Observable
final class StudioFlow {
    enum Route: Hashable { case pick, batch, run(RunContext), result(ResultContext) }

    struct UploadState: Equatable {
        enum Stage: Equatable { case converting(count: Int), uploading(index: Int, total: Int, percent: Int) }
        var stage: Stage
        var filename: String
    }

    var path: [Route] = []
    var items: [BatchItem] = []
    /// The single-flow photo (one upload, a rerun, or a chained result).
    var pick: BatchItem?
    var preselect: Transformation?
    var upload: UploadState?
    var uploadError: String?
    var batchNotice: String?

    func reset() {
        path = []
        items = []
        pick = nil
        preselect = nil
        upload = nil
        uploadError = nil
    }

    /// Open the pick screen for one photo, optionally with a fix pre-selected
    /// (the escape hatch and the chain nudge both land here).
    func startPick(_ item: BatchItem, preselect: Transformation?, session: AppSession) {
        items = []
        pick = item
        self.preselect = preselect
        if let t = preselect { item.fix = .run(t) }
        session.selectedTab = .studio
        path = [.pick]
    }

    /// Uploads one file after another, on purpose: five parallel uploads on
    /// driveway 5G is how you get five timeouts. One bad file is reported and
    /// the rest carry on. One photo → the pick screen; more → the batch picker.
    func uploadAll(_ files: [PickedFile], session: AppSession) async {
        uploadError = nil
        items = []
        pick = nil
        preselect = nil
        var bad: [String] = []
        var prepared: [(PreparedImage, UIImage?)] = []
        var converted = 0
        for file in files {
            let namedHeic = file.name.lowercased().hasSuffix(".heic") || file.name.lowercased().hasSuffix(".heif")
            if ImagePrep.sniff(file.data) == .heic || namedHeic {
                converted += 1
                upload = UploadState(stage: .converting(count: converted), filename: file.name)
                await Task.yield()
            }
            do {
                let p = try await Task.detached(priority: .userInitiated) { try ImagePrep.prepare(data: file.data, filename: file.name) }.value
                prepared.append((p, UIImage(data: p.data)))
            } catch let e as ImagePrepError {
                bad.append("\(file.name) — \(e.suffix)")
            } catch {
                bad.append("\(file.name) — \(ImagePrepError.unreadable.suffix)")
            }
        }
        guard !prepared.isEmpty else {
            upload = nil
            uploadError = bad.isEmpty ? "Nothing to upload." : bad.joined(separator: "; ")
            return
        }

        let total = prepared.count
        let totalBytes = prepared.reduce(0) { $0 + Int64($1.0.data.count) }
        var doneBytes: Int64 = 0
        for (i, (p, preview)) in prepared.enumerated() {
            let done = doneBytes
            upload = UploadState(stage: .uploading(index: i + 1, total: total, percent: pct(done, totalBytes)), filename: p.filename)
            do {
                let photo = try await session.api.upload(p) { sent, _ in
                    Task { @MainActor in
                        self.upload = UploadState(stage: .uploading(index: i + 1, total: total, percent: self.pct(done + sent, totalBytes)), filename: p.filename)
                    }
                }
                if let preview { session.localPreviews[photo.photoId] = preview }
                let item = BatchItem(name: p.filename, preview: preview, photo: photo)
                items.append(item)
                Task { await self.pollScene(item, session: session) }
            } catch let e as APIError {
                if e == .notSignedIn { upload = nil; return }
                bad.append("\(p.filename) — \(e.message)")
            } catch {
                bad.append("\(p.filename) — \(APIError.uploadNetwork.message)")
            }
            doneBytes += Int64(p.data.count)
        }
        upload = nil
        if !bad.isEmpty { uploadError = bad.joined(separator: "; ") }
        guard !items.isEmpty else { return }
        if items.count == 1 {
            pick = items[0]
            path = [.pick]
        } else {
            path = [.batch]
        }
    }

    private func pct(_ done: Int64, _ total: Int64) -> Int {
        guard total > 0 else { return 0 }
        return min(100, Int((Double(done) / Double(total) * 100).rounded()))
    }

    /// Quietly: up to 15 polls at 1.2s. The buttons narrow the instant the
    /// classifier reports — unless the person has already picked, in which
    /// case nothing changes under their thumb; the server re-checks anyway.
    func pollScene(_ item: BatchItem, session: AppSession) async {
        for _ in 0..<15 {
            try? await Task.sleep(for: .seconds(1.2))
            guard let scene: SceneResponse = try? await session.api.get("/api/photos/\(item.photoId)/scene") else {
                continue
            }
            guard scene.ready else { continue }
            if item.chosen == nil { item.apply(scene) } else { item.classifying = false }
            return
        }
    }
}
