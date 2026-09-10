import SwiftUI

/// An image from `/api/photos/<key>`, fetched with the session attached
/// (AsyncImage cannot send headers). Placeholder: the empty thumbnail ground.
struct RemoteImage: View {
    @Environment(AppSession.self) private var session
    let path: String?
    var contentMode: ContentMode = .fill
    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        ZStack {
            Theme.surface3
            if let image, contentMode == .fill {
                // Drawn as an overlay on a clear box so the photo's own size
                // never decides the tile's — a wide photo used to push its
                // card past the grid column (Kyle's phone, 10 Sep 2026).
                Color.clear
                    .overlay(Image(uiImage: image).resizable().scaledToFill())
                    .clipped()
                    .transition(.opacity)
            } else if let image {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: contentMode)
            } else if failed {
                Image(systemName: "photo")
                    .foregroundStyle(Theme.textFaint)
            }
        }
        .task(id: path) { await load() }
    }

    private func load() async {
        image = nil
        failed = false
        guard let path else { failed = true; return }
        if let data = try? await session.api.imageData(path), let ui = UIImage(data: data) {
            withAnimation(.easeOut(duration: 0.3)) { image = ui }
        } else {
            failed = true
        }
    }
}

/// Loads one image's bytes for the slider, which needs real UIImages.
@MainActor
func loadImage(_ session: AppSession, _ path: String?) async -> UIImage? {
    guard let path, let data = try? await session.api.imageData(path) else { return nil }
    return UIImage(data: data)
}
