import SwiftUI
import SafariServices
import UIKit
import Photos

/// Terms, Privacy, FAQ and the founder page open in Safari's view controller.
struct SafariView: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> SFSafariViewController {
        let vc = SFSafariViewController(url: url)
        vc.preferredBarTintColor = UIColor(Theme.bg)
        vc.preferredControlTintColor = UIColor(Theme.pine)
        return vc
    }
    func updateUIViewController(_ vc: SFSafariViewController, context: Context) {}
}

/// The system share sheet — the secondary road for a result, and the way a
/// ZIP reaches Files.
struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    var onDone: (() -> Void)? = nil
    func makeUIViewController(context: Context) -> UIActivityViewController {
        let vc = UIActivityViewController(activityItems: items, applicationActivities: nil)
        vc.completionWithItemsHandler = { _, _, _, _ in onDone?() }
        return vc
    }
    func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
}

/// The camera, for the "take a photo" alternative. The library picker is PHPicker.
struct CameraPicker: UIViewControllerRepresentable {
    let onImage: (UIImage?) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onImage: onImage) }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }
    func updateUIViewController(_ vc: UIImagePickerController, context: Context) {}

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onImage: (UIImage?) -> Void
        init(onImage: @escaping (UIImage?) -> Void) { self.onImage = onImage }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            onImage(info[.originalImage] as? UIImage)
        }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { onImage(nil) }
    }
}

/// Writes finished JPEGs straight into the Photos library — the one obvious
/// road from the app to the camera roll. Add-only permission, nothing read.
enum PhotoSaver {
    enum SaveError: Error { case denied, failed }

    static func save(_ datas: [Data]) async throws {
        let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        guard status == .authorized || status == .limited else { throw SaveError.denied }
        do {
            try await PHPhotoLibrary.shared().performChanges {
                for data in datas {
                    let request = PHAssetCreationRequest.forAsset()
                    request.addResource(with: .photo, data: data, options: nil)
                }
            }
        } catch {
            throw SaveError.failed
        }
    }

    static let deniedMessage = "Listing Lab can't save to your library — allow it under Settings → Listing Lab → Photos."
}

/// A temporary file with the web's download name, for the share sheet.
enum TempFile {
    static func write(_ data: Data, named name: String) throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("listing-lab-share", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent(name)
        try data.write(to: url, options: .atomic)
        return url
    }
}

/// `listing-lab-<transformation>[-version-N].jpg`, as the web names downloads.
func resultFilename(_ transformation: String, version: Int? = nil, index: Int? = nil) -> String {
    var name = "listing-lab-"
    if let index { name += String(format: "%02d-", index) }
    name += transformation
    if let version, version > 1 { name += "-version-\(version)" }
    return name + ".jpg"
}
