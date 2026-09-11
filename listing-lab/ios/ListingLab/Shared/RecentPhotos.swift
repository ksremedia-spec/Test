import SwiftUI
import Photos
import UniformTypeIdentifiers

/// THE LAST FEW SHOTS, RIGHT THERE (Kyle, 11 Sep 2026).
///
/// Starting a job meant tapping the drop zone, waiting for Apple's picker,
/// scrolling to the top of a camera roll, choosing, and confirming. A house
/// is photographed in one sitting, so the photo wanted is almost always one
/// of the last few — which an app can simply show. Tap one, tap Add, it is
/// uploading. Apple's picker stays for everything else.
///
/// Read access to the library is asked for here and nowhere else; refused,
/// the strip does not appear and the rest of the screen is unchanged.
@MainActor
@Observable
final class RecentPhotos {
    struct Item: Identifiable, Equatable {
        let id: String          // the asset's local identifier
        var thumbnail: UIImage?
        static func == (a: Item, b: Item) -> Bool { a.id == b.id && a.thumbnail === b.thumbnail }
    }

    private(set) var items: [Item] = []
    private(set) var allowed = false
    private(set) var asked = false
    var selected: [String] = []

    static let count = 24
    private let manager = PHImageManager.default()

    /// Ask once, then read. `.limited` is a yes to whatever was shared.
    func loadIfPossible() async {
        guard !asked else { return }
        asked = true
        let status = await withCheckedContinuation { c in
            PHPhotoLibrary.requestAuthorization(for: .readWrite) { c.resume(returning: $0) }
        }
        allowed = status == .authorized || status == .limited
        guard allowed else { return }
        await load()
    }

    func load() async {
        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        options.predicate = NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue)
        options.fetchLimit = Self.count
        let assets = PHAsset.fetchAssets(with: options)

        var found: [Item] = []
        assets.enumerateObjects { asset, _, _ in found.append(Item(id: asset.localIdentifier, thumbnail: nil)) }
        items = found
        for (index, item) in found.enumerated() {
            if let image = await thumbnail(for: item.id), index < items.count, items[index].id == item.id {
                items[index].thumbnail = image
            }
        }
    }

    private func thumbnail(for id: String) async -> UIImage? {
        guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject else { return nil }
        let options = PHImageRequestOptions()
        options.deliveryMode = .opportunistic
        options.isNetworkAccessAllowed = true       // a photo that lives in iCloud still shows
        options.resizeMode = .fast
        let side = 240 * UIScreen.main.scale
        return await withCheckedContinuation { c in
            var answered = false
            manager.requestImage(for: asset, targetSize: CGSize(width: side, height: side),
                                 contentMode: .aspectFill, options: options) { image, info in
                // Opportunistic delivery calls back twice: a quick blurry one,
                // then the real one. Resume on the first that is not a stand-in.
                let degraded = (info?[PHImageResultIsDegradedKey] as? Bool) ?? false
                guard !answered, !degraded || image == nil else { return }
                answered = true
                c.resume(returning: image)
            }
        }
    }

    /// The photograph itself, as its own bytes and name, for the upload path
    /// that already knows how to convert and check them.
    func file(for id: String, index: Int) async -> PickedFile? {
        guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject else { return nil }
        let options = PHImageRequestOptions()
        options.isNetworkAccessAllowed = true
        options.deliveryMode = .highQualityFormat
        options.version = .current
        return await withCheckedContinuation { c in
            manager.requestImageDataAndOrientation(for: asset, options: options) { data, uti, _, _ in
                guard let data else { c.resume(returning: nil); return }
                let ext = uti.flatMap { UTType($0)?.preferredFilenameExtension } ?? "jpg"
                c.resume(returning: PickedFile(name: "photo-\(index + 1).\(ext)", data: data))
            }
        }
    }

    func toggle(_ id: String) {
        if let i = selected.firstIndex(of: id) { selected.remove(at: i) } else { selected.append(id) }
    }
}

/// The strip itself: a row of the latest shots above the drop zone.
struct RecentStrip: View {
    @Bindable var recents: RecentPhotos
    let disabled: Bool
    let onUse: ([String]) -> Void

    var body: some View {
        if recents.allowed, !recents.items.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                FieldLabel(text: "Recents")
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(recents.items) { item in
                            tile(item)
                        }
                    }
                    .padding(.horizontal, 1)
                }
                if !recents.selected.isEmpty {
                    Button(recents.selected.count == 1 ? "Add 1 photo" : "Add \(recents.selected.count) photos") {
                        onUse(recents.selected)
                        recents.selected = []
                    }
                    .buttonStyle(PrimaryButtonStyle(small: true))
                    .disabled(disabled)
                }
            }
        }
    }

    private func tile(_ item: RecentPhotos.Item) -> some View {
        let picked = recents.selected.contains(item.id)
        return Button {
            Haptics.tap()
            recents.toggle(item.id)
        } label: {
            ZStack(alignment: .topTrailing) {
                Color.clear
                    .overlay {
                        if let image = item.thumbnail {
                            Image(uiImage: image).resizable().scaledToFill()
                        } else {
                            Theme.surface3
                        }
                    }
                    .frame(width: 74, height: 74)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.rSm))
                    .overlay(RoundedRectangle(cornerRadius: Theme.rSm)
                        .stroke(picked ? Theme.pine : Theme.line, lineWidth: picked ? 2 : 1))
                if picked {
                    Circle().fill(Theme.pine).frame(width: 18, height: 18)
                        .overlay(Text("✓").font(.system(size: 10, weight: .bold)).foregroundStyle(Theme.onPine))
                        .padding(4)
                }
            }
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .accessibilityLabel(picked ? "Selected photo" : "Recent photo")
    }
}
