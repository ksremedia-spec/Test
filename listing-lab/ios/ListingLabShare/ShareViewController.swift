import UIKit
import SwiftUI
import UniformTypeIdentifiers

/// SHARE STRAIGHT FROM PHOTOS (Kyle, 11 Sep 2026).
///
/// Select shots in the camera roll, tap Share, choose Listing Lab, pick what
/// to do: the photos upload and the jobs start without the app being opened
/// at all. The notification arrives later, as for any other job.
///
/// The sheet does the whole thing itself, using the session token the app
/// keeps in the shared keychain group. It cannot reach the app's networking
/// or its design system — a different module, a different process — so it
/// carries the few colours it needs and the two requests it makes
/// (ListingLabShared/ShareAPI.swift).
final class ShareViewController: UIViewController {
    private var images: [(name: String, data: Data)] = []

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        Task { await loadAttachments() }
    }

    /// What Photos handed over, as bytes. Each attachment is asked for its
    /// image; anything that will not come across is skipped rather than
    /// failing the whole share.
    private func loadAttachments() async {
        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        var found: [(String, Data)] = []
        var index = 0
        for item in items {
            for provider in item.attachments ?? [] {
                guard provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) else { continue }
                index += 1
                if let (name, data) = await load(provider, index: index) { found.append((name, data)) }
            }
        }
        images = found
        present()
    }

    private func load(_ provider: NSItemProvider, index: Int) async -> (String, Data)? {
        await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: UTType.image.identifier, options: nil) { item, _ in
                switch item {
                case let url as URL:
                    let data = try? Data(contentsOf: url)
                    continuation.resume(returning: data.map { (url.lastPathComponent, $0) })
                case let image as UIImage:
                    let data = image.jpegData(compressionQuality: 0.95)
                    continuation.resume(returning: data.map { ("photo-\(index).jpg", $0) })
                case let data as Data:
                    continuation.resume(returning: ("photo-\(index).jpg", data))
                default:
                    continuation.resume(returning: nil)
                }
            }
        }
    }

    private func present() {
        let root = ShareSheetView(
            count: images.count,
            signedIn: Keychain.load() != nil,
            run: { [weak self] choice in await self?.run(choice) ?? "Something went wrong." },
            close: { [weak self] in self?.finish() }
        )
        let host = UIHostingController(rootView: root)
        host.view.backgroundColor = .clear
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)
    }

    /// Convert, upload and start, one photograph at a time — a share sheet is
    /// given little memory, and a batch of 25MB iPhone photos will use it all
    /// if they are held at once. Returns nil when every one got away, or the
    /// sentence to show when one did not.
    private func run(_ choice: ShareChoice) async -> String? {
        guard let token = Keychain.load() else { return ShareAPI.Failure.notSignedIn.text }
        var started = 0
        for (name, data) in images {
            do {
                let prepared = try ImagePrep.prepare(data: data, filename: name)
                let photoId = try await ShareAPI.upload(prepared, token: token)
                try await ShareAPI.start(photoId: photoId, transformation: choice.transformation,
                                         style: choice.style, roomType: choice.roomType, token: token)
                started += 1
            } catch let e as ImagePrepError {
                return "\(name) — \(e.suffix)"
            } catch let e as ShareAPI.Failure {
                // Some may already have started; say so rather than implying none did.
                return started > 0 ? "\(started) started, then: \(e.text)" : e.text
            } catch {
                return "Something went wrong."
            }
        }
        return nil
    }

    private func finish() {
        extensionContext?.completeRequest(returningItems: nil)
    }
}

/// What the person chose in the sheet.
struct ShareChoice {
    let transformation: String
    let style: String?
    let roomType: String?
}

/// The app's colours, the few this sheet needs (assets/brand.md).
private enum SheetTheme {
    static let bg = Color(red: 0x0C / 255, green: 0x11 / 255, blue: 0x18 / 255)
    static let surface = Color(red: 0x19 / 255, green: 0x22 / 255, blue: 0x2E / 255)
    static let line = Color(red: 0x29 / 255, green: 0x35 / 255, blue: 0x46 / 255)
    static let text = Color(red: 0xE9 / 255, green: 0xED / 255, blue: 0xF3 / 255)
    static let textSoft = Color(red: 0xA0 / 255, green: 0xAB / 255, blue: 0xBA / 255)
    static let pine = Color(red: 0x4E / 255, green: 0x8F / 255, blue: 0xD0 / 255)
    static let onPine = Color(red: 0x08 / 255, green: 0x13 / 255, blue: 0x1F / 255)
    static let bad = Color(red: 0xE2 / 255, green: 0x61 / 255, blue: 0x5A / 255)
}

struct ShareSheetView: View {
    let count: Int
    let signedIn: Bool
    let run: (ShareChoice) async -> String?
    let close: () -> Void

    @State private var style = "Standard"
    @State private var room = "Living Room"
    @State private var busy: String?
    @State private var error: String?
    @State private var done = false

    // The closed lists, the server's order — the same four fixes as the app.
    private let fixes: [(label: String, key: String)] = [
        ("Declutter", "declutter"),
        ("Empty the room", "empty"),
        ("Virtual staging", "staging"),
        ("Twilight", "twilight"),
    ]
    private let styles = ["Standard", "Modern", "Contemporary", "Coastal", "Luxury"]
    private let rooms = ["Living Room", "Dining Room", "Primary Bedroom", "Guest Bedroom",
                         "Nursery / Kids Room", "Basement / Rec Room", "Home Office", "Other"]

    var body: some View {
        ZStack {
            SheetTheme.bg.ignoresSafeArea()
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text("Listing Lab").font(.system(size: 20, weight: .bold)).foregroundStyle(SheetTheme.text)
                    Spacer()
                    Button("Close", action: close).foregroundStyle(SheetTheme.textSoft)
                }
                if done {
                    Text(count == 1 ? "Started. We'll let you know when it's ready."
                                    : "Started \(count) photos. We'll let you know when they're ready.")
                        .font(.system(size: 15)).foregroundStyle(SheetTheme.text)
                } else if !signedIn {
                    Text("Sign in to Listing Lab first.").font(.system(size: 15)).foregroundStyle(SheetTheme.text)
                } else if count == 0 {
                    Text("Nothing to upload.").font(.system(size: 15)).foregroundStyle(SheetTheme.text)
                } else if let busy {
                    HStack(spacing: 10) {
                        ProgressView().tint(SheetTheme.pine)
                        Text(busy).font(.system(size: 15)).foregroundStyle(SheetTheme.text)
                    }
                    Text("Keep this open until it's done.")
                        .font(.system(size: 13)).foregroundStyle(SheetTheme.textSoft)
                } else {
                    Text(count == 1 ? "What should we do to it?" : "What should we do to all \(count)?")
                        .font(.system(size: 17, weight: .semibold)).foregroundStyle(SheetTheme.text)
                    ForEach(fixes, id: \.key) { fix in
                        Button { choose(fix.key) } label: {
                            Text(fix.label)
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(SheetTheme.onPine)
                                .frame(maxWidth: .infinity, minHeight: 46)
                                .background(SheetTheme.pine, in: RoundedRectangle(cornerRadius: 6))
                        }
                        if fix.key == "staging" {
                            HStack(spacing: 8) {
                                picker("Style", styles, $style)
                                picker("Room", rooms, $room)
                            }
                        }
                    }
                }
                if let error {
                    Text(error).font(.system(size: 13)).foregroundStyle(SheetTheme.bad)
                }
                Spacer()
            }
            .padding(18)
        }
    }

    private func picker(_ title: String, _ options: [String], _ binding: Binding<String>) -> some View {
        Menu {
            Picker(title, selection: binding) {
                ForEach(options, id: \.self) { Text($0).tag($0) }
            }
        } label: {
            HStack(spacing: 4) {
                Text(binding.wrappedValue).lineLimit(1)
                Image(systemName: "chevron.down").font(.system(size: 10, weight: .semibold))
            }
            .font(.system(size: 13))
            .foregroundStyle(SheetTheme.text)
            .padding(.horizontal, 10).padding(.vertical, 8)
            .frame(maxWidth: .infinity)
            .background(SheetTheme.surface, in: RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(SheetTheme.line, lineWidth: 1))
        }
    }

    private func choose(_ key: String) {
        error = nil
        busy = count == 1 ? "Uploading…" : "Uploading \(count) photos…"
        // Twilight is one look; staging carries the two the server asks for.
        let choice = ShareChoice(transformation: key,
                                 style: key == "staging" ? style : (key == "twilight" ? "Dusk" : nil),
                                 roomType: key == "staging" ? room : nil)
        Task {
            let failure = await run(choice)
            busy = nil
            if let failure { error = failure } else { done = true }
        }
    }
}
