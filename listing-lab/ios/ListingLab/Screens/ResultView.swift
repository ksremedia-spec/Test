import SwiftUI

/// The result: `Cleared for delivery` with the slider, versions, one obvious
/// Save button and a quiet download line; or the returned states, which
/// explain themselves in the server's words and say the credits are back.
struct ResultView: View {
    @Environment(AppSession.self) private var session
    let context: ResultContext
    /// The library passes a closure that pops its own stack first.
    var onAnotherPhoto: (() -> Void)? = nil

    var body: some View {
        StudioPage {
            VStack(alignment: .leading, spacing: 14) {
                if context.jobStatus == .delivered, let resultUrl = context.resultUrl {
                    CardHeading(title: "Cleared for delivery", sub: "It passed every check. Drag the slider to compare.")
                    DeliveredResultBody(jobId: context.jobId, transformation: context.transformation,
                                        photoId: context.photoId, originalPath: context.originalPath,
                                        urls: [resultUrl] + context.variantUrls, wording: .result,
                                        anotherPhoto: anotherPhoto)
                } else {
                    returned
                }
            }
            .card()
        }
        .navigationBarBackButtonHidden(true)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { CreditChip() } }
        .task { await session.refreshCredits() }
    }

    private func anotherPhoto() {
        if let onAnotherPhoto { onAnotherPhoto() }
        session.flow.reset()
        session.selectedTab = .studio
    }

    private var returned: some View {
        let status = context.jobStatus
        let rejected = status == .rejected
        return VStack(alignment: .leading, spacing: 14) {
            CardHeading(title: ReturnedJob.title(status))
            NoteBox { Text(context.note ?? ReturnedJob.defaultResultNote(status)) }
            Text(context.customerMessage ?? (rejected
                ? "Your credits have been returned."
                : "The run was interrupted before it could finish. Your credits have been returned."))
                .font(Theme.ui(14.5, weight: .semibold)).foregroundStyle(Theme.text)
            Text("Your original photo is untouched." + (rejected
                ? " This is the system working as intended — it would rather deliver nothing than deliver something that misrepresents the property."
                : ""))
                .font(Theme.ui(13)).foregroundStyle(Theme.textFaint)
            if rejected, context.transformation == .declutter, let photoId = context.photoId {
                NoteBox {
                    Text("Rooms this full are usually beyond a tidy-up. Empty Room clears everything in one pass — and your credits are already back.")
                    Button("Try Empty Room") { tryEmptyRoom(photoId: photoId) }
                        .buttonStyle(PrimaryButtonStyle(small: true))
                }
            }
            Button("Another photo") { anotherPhoto() }
                .buttonStyle(GhostButtonStyle())
            AILine()
            ReportProblemView(jobId: context.jobId, wording: .result)
        }
    }

    /// The escape hatch: the pick screen with Empty Room pre-selected on the same photo.
    private func tryEmptyRoom(photoId: String) {
        let item = BatchItem(name: "photo.jpg", preview: session.localPreviews[photoId],
                             photoId: photoId, originalPath: context.originalPath ?? "",
                             offers: Transformation.allCases)
        if let onAnotherPhoto { onAnotherPhoto() }
        session.flow.startPick(item, preselect: .empty, session: session)
        Task { await session.flow.pollScene(item, session: session) }
    }
}

/// `AI can make mistakes — please double-check before it goes live.` — one
/// quiet line on every result, because the checker is good, not perfect.
struct AILine: View {
    var body: some View {
        Text("AI can make mistakes — please double-check before it goes live.")
            .font(Theme.ui(11))
            .lineSpacing(3)
            .foregroundStyle(Theme.textFaint)
            .opacity(0.55)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.top, 12)
    }
}

enum ResultWording { case result, viewer }

/// Everything a delivered result offers, shared by the fresh result screen
/// and the library viewer: the slider, the versions, Save to Camera Roll
/// with the quiet download line, the AI line, the chain nudge, the report link.
struct DeliveredResultBody: View {
    @Environment(AppSession.self) private var session
    let jobId: String
    let transformation: Transformation
    let photoId: String?
    let originalPath: String?
    /// `resultUrl` first, then the extra versions.
    let urls: [String]
    let wording: ResultWording
    var anotherPhoto: (() -> Void)? = nil
    var onLeave: (() -> Void)? = nil

    @State private var version = 0
    @State private var before: UIImage?
    @State private var after: UIImage?
    @State private var saving = false
    @State private var share: ShareFile?
    @State private var chaining = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let after {
                BeforeAfterSlider(before: before, after: after)
            } else {
                ZStack { Theme.surface3; ProgressView().tint(Theme.textSoft) }
                    .aspectRatio(4 / 3, contentMode: .fit)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.rMd))
            }
            if urls.count > 1 {
                VStack(alignment: .leading, spacing: 8) {
                    Text("\(urls.count) versions passed our checks — keep the one you love:")
                        .font(Theme.ui(13)).foregroundStyle(Theme.textFaint)
                    HStack(spacing: 8) {
                        ForEach(urls.indices, id: \.self) { i in
                            Button("Version \(i + 1)") { version = i }
                                .buttonStyle(VersionPillStyle(selected: version == i))
                        }
                    }
                }
            }
            HStack(spacing: 10) {
                if let anotherPhoto {
                    Button("Another photo") { anotherPhoto() }
                        .buttonStyle(GhostButtonStyle())
                }
                Button {
                    Task { await save() }
                } label: {
                    if saving { ButtonSpinner() } else { Text("Save to Camera Roll") }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(saving || after == nil)
            }
            Button("or download the file") { Task { await download() } }
                .buttonStyle(LinkButtonStyle())
                .frame(maxWidth: .infinity)
                .disabled(saving)
            AILine()
            if transformation == .empty {
                NoteBox {
                    Text("Now that it's empty — want to furnish it? Buyers linger longer on staged rooms.")
                    Button(chaining ? "One moment…" : "Stage this room") { Task { await stageThisRoom() } }
                        .buttonStyle(PrimaryButtonStyle(small: true))
                        .disabled(chaining)
                }
            }
            ReportProblemView(jobId: jobId, wording: wording)
        }
        .task(id: version) { await loadAfter() }
        .task {
            if let local = session.localPreviews[photoId ?? ""] { before = local }
            else { before = await loadImage(session, originalPath) }
        }
        .sheet(item: $share) { file in ShareSheet(items: [file.url]) }
    }

    private var currentURL: String { urls[min(version, urls.count - 1)] }

    private func loadAfter() async {
        after = await loadImage(session, currentURL)
    }

    private func save() async {
        saving = true
        defer { saving = false }
        do {
            let data = try await session.api.fileData(currentURL)
            try await PhotoSaver.save([data])
            session.toasts.show("Saved to your camera roll.")
        } catch PhotoSaver.SaveError.denied {
            session.toasts.show(PhotoSaver.deniedMessage)
        } catch let e as APIError {
            session.toasts.show(e.message)
        } catch {
            session.toasts.show("Could not save that just now.")
        }
    }

    private func download() async {
        do {
            let data = try await session.api.fileData(currentURL)
            let url = try TempFile.write(data, named: resultFilename(transformation.rawValue, version: version + 1))
            share = ShareFile(url: url)
        } catch let e as APIError {
            session.toasts.show(e.message)
        } catch {
            session.toasts.show("Could not save that just now.")
        }
    }

    /// Server-side copy of the clean, pre-watermark result as a new photo,
    /// then the pick screen with staging pre-selected.
    private func stageThisRoom() async {
        chaining = true
        defer { chaining = false }
        do {
            let photo: UploadedPhoto = try await session.api.post("/api/photos/from-job", ["jobId": jobId])
            let item = BatchItem(name: "photo.jpg", preview: nil, photo: photo)
            onLeave?()
            session.flow.startPick(item, preselect: .staging, session: session)
            Task { await session.flow.pollScene(item, session: session) }
        } catch let e as APIError {
            session.toasts.show(e == .decoding || e.isRetryable ? "Could not start staging." : e.message)
        } catch {
            session.toasts.show("Could not start staging.")
        }
    }
}

struct ShareFile: Identifiable {
    let url: URL
    var id: String { url.path }
}

/// The `Version N` pills — `.opt` styling, pressed state in pine-deep.
struct VersionPillStyle: ButtonStyle {
    let selected: Bool
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.ui(14, weight: .semibold))
            .foregroundStyle(Theme.text)
            .padding(EdgeInsets(top: 8, leading: 14, bottom: 8, trailing: 14))
            .background(selected ? Theme.pineDeep : Theme.surface2, in: RoundedRectangle(cornerRadius: Theme.rSm))
            .overlay(RoundedRectangle(cornerRadius: Theme.rSm).stroke(selected ? Theme.pine : Theme.line, lineWidth: 1))
    }
}

/// The discreet `Something not right with this photo?` link and the form it reveals.
struct ReportProblemView: View {
    @Environment(AppSession.self) private var session
    let jobId: String
    let wording: ResultWording
    @State private var open = false
    @State private var text = ""
    @State private var sending = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button("Something not right with this photo?") { open.toggle() }
                .buttonStyle(LinkButtonStyle(size: 12.5))
            if open {
                ZStack(alignment: .topLeading) {
                    if text.isEmpty {
                        Text("Tell us what looks wrong — we read every one.")
                            .font(Theme.ui(16)).foregroundStyle(Theme.textFaint)
                            .padding(EdgeInsets(top: 20, leading: 18, bottom: 0, trailing: 0))
                    }
                    TextEditor(text: $text)
                        .scrollContentBackground(.hidden)
                        .font(Theme.ui(16)).foregroundStyle(Theme.text)
                        .frame(minHeight: 84)
                        .fieldChrome()
                        .onChange(of: text) { _, new in if new.count > 2000 { text = String(new.prefix(2000)) } }
                }
                Button { Task { await send() } } label: { if sending { ProgressView().tint(Theme.text) } else { Text("Send") } }
                    .buttonStyle(GhostButtonStyle())
                    .disabled(sending)
            }
        }
    }

    private func send() async {
        let message = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty else { session.toasts.show("Tell us what looks wrong first."); return }
        sending = true
        defer { sending = false }
        do {
            let res: ReportResponse = try await session.api.post("/api/report", ["jobId": jobId, "message": message])
            open = false
            text = ""
            switch wording {
            case .result:
                session.toasts.show(res.alreadyReported == true ? "We've already got your note on this one — it's in the queue." : "Thanks — we've got it and we'll take a look.")
            case .viewer:
                session.toasts.show(res.alreadyReported == true ? "Already flagged — we have it." : "Thank you — we'll take a look.")
            }
        } catch let e as APIError {
            let fallback = wording == .result ? "Could not send that just now." : "Could not send just now."
            session.toasts.show(e.isRetryable || e == .decoding ? fallback : e.message)
        } catch {
            session.toasts.show(wording == .result ? "Could not send that just now." : "Could not send just now.")
        }
    }
}
