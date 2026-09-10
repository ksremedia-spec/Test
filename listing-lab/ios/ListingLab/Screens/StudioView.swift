import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

/// The "New photos" tab: upload → pick (or batch) → run → result.
struct StudioView: View {
    @Environment(AppSession.self) private var session

    var body: some View {
        @Bindable var flow = session.flow
        NavigationStack(path: $flow.path) {
            UploadView()
                .navigationDestination(for: StudioFlow.Route.self) { route in
                    switch route {
                    case .pick:
                        PickView()
                    case .batch:
                        BatchView()
                    case .run(let ctx):
                        RunView(context: ctx) { result in
                            // The result takes the run screen's place.
                            if !flow.path.isEmpty { flow.path.removeLast() }
                            flow.path.append(.result(result))
                        }
                    case .result(let ctx):
                        ResultView(context: ctx)
                    }
                }
        }
    }
}

/// `Start with your photos` — the drop zone, as a phone offers it: the photo
/// library (multi-select) first, the camera and Files as alternatives. No
/// `capture` lock: agents shoot a house and upload later.
struct UploadView: View {
    @Environment(AppSession.self) private var session
    @State private var picked: [PhotosPickerItem] = []
    @State private var showCamera = false
    @State private var showFiles = false

    private var flow: StudioFlow { session.flow }

    var body: some View {
        StudioPage {
            BrandBar()
            VStack(alignment: .leading, spacing: 14) {
                CardHeading(title: "Start with your photos",
                            sub: "Pick one or several. Choose what to do with each, start them together, and put your phone away.")
                PhotosPicker(selection: $picked, maxSelectionCount: nil, matching: .images, photoLibrary: .shared()) {
                    dropZone
                }
                .buttonStyle(.plain)
                .disabled(flow.upload != nil)
                .accessibilityLabel("Choose photos")
                HStack(spacing: 10) {
                    Button { showCamera = true } label: { Label("Take Photo", systemImage: "camera") }
                        .buttonStyle(GhostButtonStyle(small: true))
                        .disabled(flow.upload != nil || !UIImagePickerController.isSourceTypeAvailable(.camera))
                    Button { showFiles = true } label: { Label("Browse", systemImage: "folder") }
                        .buttonStyle(GhostButtonStyle(small: true))
                        .disabled(flow.upload != nil)
                }
                if let error = flow.uploadError { ErrorBox(message: error) }
            }
            .card()
        }
        .toolbar(.hidden, for: .navigationBar)
        .onChange(of: picked) { _, items in
            guard !items.isEmpty else { return }
            let chosen = items
            picked = []
            Task { await importFromLibrary(chosen) }
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker { image in
                showCamera = false
                guard let image else { return }
                Task { await importFromCamera(image) }
            }
            .ignoresSafeArea()
        }
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.image], allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            Task { await importFromFiles(urls) }
        }
    }

    /// The drop zone's three faces: idle, converting, uploading.
    private var dropZone: some View {
        VStack(spacing: 8) {
            switch flow.upload?.stage {
            case .converting(let count):
                Text(count > 1 ? "Converting iPhone photos…" : "Converting iPhone photo…")
                    .font(Theme.display(18, weight: .semibold, relativeTo: .title3))
                    .foregroundStyle(Theme.text)
                Text(flow.upload?.filename ?? "")
                    .font(Theme.ui(13)).foregroundStyle(Theme.textFaint).lineLimit(1)
            case .uploading(let index, let total, let percent):
                Text("Uploading \(index) of \(total)…")
                    .font(Theme.display(18, weight: .semibold, relativeTo: .title3))
                    .foregroundStyle(Theme.text)
                Text(flow.upload?.filename ?? "")
                    .font(Theme.ui(13)).foregroundStyle(Theme.textFaint).lineLimit(1)
                ProgressBar(percent: Double(percent))
                    .frame(maxWidth: 280)
                Text("\(percent)%")
                    .font(Theme.ui(13)).monospacedDigit().foregroundStyle(Theme.textSoft)
            case .none:
                Text("Choose photos")
                    .font(Theme.display(18, weight: .semibold, relativeTo: .title3))
                    .foregroundStyle(Theme.text)
                Text("JPEG, PNG or iPhone HEIC, up to 25MB each — pick as many as you like")
                    .font(Theme.ui(13)).foregroundStyle(Theme.textFaint)
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(EdgeInsets(top: 34, leading: 18, bottom: 34, trailing: 18))
        .background(Theme.surface2, in: RoundedRectangle(cornerRadius: Theme.rMd))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.rMd)
                .strokeBorder(style: StrokeStyle(lineWidth: 1.5, dash: [6, 4]))
                .foregroundStyle(Theme.line)
        )
    }

    private func importFromLibrary(_ items: [PhotosPickerItem]) async {
        var files: [PickedFile] = []
        for (i, item) in items.enumerated() {
            guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
            let ext = item.supportedContentTypes.first?.preferredFilenameExtension ?? "jpg"
            files.append(PickedFile(name: "photo-\(i + 1).\(ext)", data: data))
        }
        guard !files.isEmpty else { flow.uploadError = "Nothing to upload."; return }
        await flow.uploadAll(files, session: session)
    }

    private func importFromCamera(_ image: UIImage) async {
        do {
            let prepared = try await Task.detached(priority: .userInitiated) { try ImagePrep.prepare(image: image) }.value
            await flow.uploadAll([PickedFile(name: prepared.filename, data: prepared.data)], session: session)
        } catch {
            flow.uploadError = "photo.jpg — \(ImagePrepError.unreadable.suffix)"
        }
    }

    private func importFromFiles(_ urls: [URL]) async {
        var files: [PickedFile] = []
        for url in urls {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            if let data = try? Data(contentsOf: url) { files.append(PickedFile(name: url.lastPathComponent, data: data)) }
        }
        guard !files.isEmpty else { flow.uploadError = "Nothing to upload."; return }
        await flow.uploadAll(files, session: session)
    }
}

/// The 6px progress track with the blue fill.
struct ProgressBar: View {
    let percent: Double
    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Theme.surface3)
                Capsule().fill(Theme.pine).frame(width: geo.size.width * min(100, max(0, percent)) / 100)
            }
        }
        .frame(height: 6)
        .animation(.linear(duration: 0.6), value: percent)
    }
}
