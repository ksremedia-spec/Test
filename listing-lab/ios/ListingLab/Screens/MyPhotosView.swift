import SwiftUI

enum LibraryRoute: Hashable { case run(RunContext), result(ResultContext) }

/// `My photos` — the screen that makes "close your phone and come back"
/// real. A photo grid with READY / WORKING / RETURNED badges, the viewer
/// sheet, the returned-job chooser, and select mode for saving many.
struct MyPhotosView: View {
    @Environment(AppSession.self) private var session
    @State private var path: [LibraryRoute] = []
    @State private var selecting = false
    @State private var selected: [String] = []
    @State private var viewer: JobSummary?
    @State private var returned: JobSummary?
    @State private var rerunning: Set<String> = []
    @State private var gathering = false
    @State private var share: ShareFile?

    private var delivered: [JobSummary] { session.jobs.filter { $0.jobStatus == .delivered } }

    var body: some View {
        NavigationStack(path: $path) {
            StudioPage {
                BrandBar()
                header
                if !session.jobsLoaded {
                    Text("Loading…").font(Theme.ui(14)).foregroundStyle(Theme.textFaint)
                } else if session.jobs.isEmpty {
                    Text("Nothing yet. Upload a photo to get started.").font(Theme.ui(14)).foregroundStyle(Theme.textFaint)
                } else {
                    grid
                }
                Button("New photos") { newPhotos() }
                    .buttonStyle(GhostButtonStyle())
            }
            .safeAreaInset(edge: .bottom) { if selecting { selectBar } }
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: LibraryRoute.self) { route in
                switch route {
                case .run(let ctx):
                    RunView(context: ctx) { result in
                        if !path.isEmpty { path.removeLast() }
                        path.append(.result(result))
                    }
                case .result(let ctx):
                    ResultView(context: ctx, onAnotherPhoto: { path = [] })
                }
            }
        }
        .task { await session.refreshJobs() }
        .task(id: session.hasWorkingJobs) { await pollWhileWorking() }
        .sheet(item: $viewer) { job in ViewerSheet(job: job, onLeave: { viewer = nil; path = [] }) }
        .sheet(item: $returned) { job in ReturnedSheet(job: job) { t in await rerun(job, as: t) } }
        .sheet(item: $share) { file in ShareSheet(items: [file.url]) }
    }

    // MARK: - Header and grid

    /// The web's `.qhead`: the title, then the actions row — which wraps
    /// under the title on a phone, each button on one line (`.card h2` 20px;
    /// `.qhead .btn` 40px tall, 14px).
    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("My photos")
                .font(Theme.display(20, weight: .semibold, relativeTo: .title3))
                .foregroundStyle(Theme.text)
            HStack(spacing: 8) {
                Button("+ Add photos") { newPhotos() }.buttonStyle(PrimaryButtonStyle(small: true))
                Button("Buy credits") { session.showBuyCredits = true }.buttonStyle(GhostButtonStyle(small: true))
                if delivered.count > 1, !selecting {
                    Button("Select") { selecting = true; selected = [] }.buttonStyle(GhostButtonStyle(small: true))
                }
            }
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
            Text(session.flow.batchNotice ?? "Everything you've run. Finished ones stay here — you can close the app and come back whenever.")
                .font(Theme.ui(14.5)).foregroundStyle(Theme.textSoft)
        }
        .padding(.top, 6)
    }

    private var grid: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 10)], spacing: 10) {
            ForEach(session.jobs) { job in
                JobCard(job: job, selecting: selecting, picked: selected.contains(job.jobId),
                        rerunning: rerunning.contains(job.jobId)) {
                    tap(job)
                }
            }
        }
    }

    private func tap(_ job: JobSummary) {
        if selecting {
            guard job.jobStatus == .delivered else { return }
            if let i = selected.firstIndex(of: job.jobId) { selected.remove(at: i) } else { selected.append(job.jobId) }
            return
        }
        switch job.jobStatus {
        case .delivered:
            viewer = job
        case .queued, .running:
            guard let t = job.kind else { return }
            // A six-minute-old job opens at 6:00, not 0:00.
            path.append(.run(RunContext(jobId: job.jobId, transformation: t, photoId: job.photoId,
                                        originalPath: job.originalUrl, startedAt: ISO.date(job.startedAt))))
        default:
            returned = job
        }
    }

    private func newPhotos() {
        selecting = false
        selected = []
        session.flow.batchNotice = nil
        session.flow.reset()
        session.selectedTab = .studio
    }

    /// Every 6s while something is queued or running, credits too; stops itself.
    private func pollWhileWorking() async {
        while session.hasWorkingJobs, !Task.isCancelled {
            try? await Task.sleep(for: .seconds(6))
            guard !Task.isCancelled else { return }
            await session.refreshJobs()
            await session.refreshCredits()
        }
    }

    // MARK: - Select mode

    private var selectBar: some View {
        let ids = delivered.map(\.jobId)
        let picked = selected.filter { ids.contains($0) }
        let n = picked.count
        let all = n == ids.count && n > 0
        return VStack(spacing: 10) {
            HStack {
                Text(n == 1 ? "1 selected" : "\(n) selected").font(Theme.ui(14)).foregroundStyle(Theme.text)
                Spacer()
                Button(all ? "Clear" : "Select all") { selected = all ? [] : ids }
                    .buttonStyle(LinkButtonStyle(color: Theme.pine, size: 14))
                Button("Cancel") { selecting = false; selected = [] }
                    .buttonStyle(LinkButtonStyle(color: Theme.textSoft, size: 14))
            }
            Button {
                Task { await saveSelected(picked) }
            } label: {
                if gathering { HStack(spacing: 8) { ButtonSpinner(); Text("Getting the photos…") } }
                else { Text(n > 1 ? "Save \(n) to Camera Roll" : "Save to Camera Roll") }
            }
            .buttonStyle(PrimaryButtonStyle())
            .dimmedWhenDisabled(n == 0 || gathering)
            Button(n > 1 ? "Download \(n) as .zip" : "Download .zip") { Task { await zipSelected(picked) } }
                .buttonStyle(LinkButtonStyle(color: Theme.textSoft, size: 14))
                .disabled(n == 0 || gathering)
        }
        .padding(14)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.rMd))
        .overlay(RoundedRectangle(cornerRadius: Theme.rMd).stroke(Theme.line, lineWidth: 1))
        .shadow(color: .black.opacity(0.6), radius: 15, y: 10)
        .padding(.horizontal, 18)
        .padding(.bottom, 10)
    }

    /// Every version of every picked job, straight into the library.
    private func saveSelected(_ ids: [String]) async {
        gathering = true
        defer { gathering = false }
        var datas: [Data] = []
        do {
            for id in ids {
                guard let job = session.jobs.first(where: { $0.jobId == id }), let result = job.resultUrl else { continue }
                for url in [result] + job.variants { datas.append(try await session.api.fileData(url)) }
            }
            guard !datas.isEmpty else { return }
            try await PhotoSaver.save(datas)
            session.toasts.show(datas.count == 1 ? "Saved to your camera roll." : "Saved \(datas.count) photos to your camera roll.")
            selecting = false
            selected = []
        } catch PhotoSaver.SaveError.denied {
            session.toasts.show(PhotoSaver.deniedMessage)
        } catch let e as APIError {
            session.toasts.show(e.message)
        } catch {
            session.toasts.show("Could not save those just now.")
        }
    }

    /// The server builds one ZIP; the share sheet hands it to Files.
    private func zipSelected(_ ids: [String]) async {
        gathering = true
        defer { gathering = false }
        do {
            let data = try await session.api.fileData("/api/jobs/zip?ids=" + ids.joined(separator: ","))
            let stamp = { let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; return f.string(from: Date()) }()
            share = ShareFile(url: try TempFile.write(data, named: "listing-lab-\(stamp).zip"))
        } catch let e as APIError {
            session.toasts.show(e.message)
        } catch {
            session.toasts.show("Could not build that download just now.")
        }
    }

    // MARK: - Rerun

    private func rerun(_ job: JobSummary, as next: Transformation) async {
        guard let photoId = job.photoId, let original = job.kind, !rerunning.contains(job.jobId) else { return }
        rerunning.insert(job.jobId)
        defer { rerunning.remove(job.jobId) }
        let request = ReturnedJob.rerunRequest(photoId: photoId, original: original, style: job.style, roomType: job.roomType, as: next)
        do {
            let res: TransformResponse = try await session.api.post("/api/transform", request)
            session.balance = res.balance
            session.toasts.show("Running it again — a fresh attempt, right here.")
            await session.refreshJobs()
        } catch let e as APIError {
            session.toasts.show(e.isRetryable || e == .decoding ? "Could not start that again just now." : e.message)
        } catch {
            session.toasts.show("Could not start that again just now.")
        }
    }
}

/// One `.pcard`: a 4:3 thumbnail, the status badge, the name and the sub line.
struct JobCard: View {
    let job: JobSummary
    let selecting: Bool
    let picked: Bool
    let rerunning: Bool
    let onTap: () -> Void

    private var inert: Bool { selecting && job.jobStatus != .delivered }

    var body: some View {
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 0) {
                ZStack(alignment: .topLeading) {
                    RemoteImage(path: job.thumbnailUrl)
                        .aspectRatio(4 / 3, contentMode: .fit)
                        .opacity(job.jobStatus == .delivered ? 1 : 0.4)
                    badge.padding(8)
                    if selecting, job.jobStatus == .delivered {
                        tick.padding(8).frame(maxWidth: .infinity, alignment: .trailing)
                    }
                }
                .clipped()
                VStack(alignment: .leading, spacing: 3) {
                    Text(job.kind?.label ?? job.transformation)
                        .font(Theme.ui(12.5, weight: .semibold)).foregroundStyle(Theme.text).lineLimit(1)
                    Text(subLine).font(Theme.ui(11)).foregroundStyle(Theme.textFaint).lineLimit(2)
                }
                .padding(EdgeInsets(top: 8, leading: 10, bottom: 10, trailing: 10))
            }
            .frame(maxWidth: .infinity)
            .background(Theme.surface2)
            .clipShape(RoundedRectangle(cornerRadius: Theme.rMd))
            .overlay(RoundedRectangle(cornerRadius: Theme.rMd).stroke(picked ? Theme.pine : Theme.line, lineWidth: picked ? 2 : 1))
            .opacity(inert ? 0.45 : 1)
        }
        .buttonStyle(.plain)
        .disabled(inert)
    }

    private var badge: some View {
        let (text, color): (String, Color) = {
            switch job.jobStatus {
            case .delivered: return ("READY", Theme.readyBadge)
            case .queued, .running: return ("WORKING", Theme.workingBadge)
            case .rejected, .failed: return ("RETURNED", Theme.returnedBadge)
            case .unknown: return (job.status.uppercased(), Theme.returnedBadge)
            }
        }()
        return HStack(spacing: 5) {
            if job.jobStatus.isWorking { PulsingDot() }
            Text(text).font(.system(size: 10.5, weight: .bold)).kerning(0.5)
        }
        .foregroundStyle(color)
        .padding(EdgeInsets(top: 4, leading: 8, bottom: 4, trailing: 8))
        .background(Color(red: 9/255, green: 13/255, blue: 21/255).opacity(0.82), in: Capsule())
    }

    private var tick: some View {
        Circle()
            .fill(picked ? Theme.pine : Color(red: 9/255, green: 13/255, blue: 21/255).opacity(0.55))
            .frame(width: 24, height: 24)
            .overlay(Circle().stroke(picked ? Theme.pine : .white.opacity(0.85), lineWidth: 2))
            .overlay { if picked { Text("✓").font(.system(size: 13, weight: .bold)).foregroundStyle(Theme.onPine) } }
    }

    private var subLine: String {
        if rerunning { return "Starting it again…" }
        switch job.jobStatus {
        case .delivered:
            let bits = [job.roomType, job.style].compactMap { $0 }.filter { !$0.isEmpty }
            return bits.isEmpty ? "Tap to view" : bits.joined(separator: " · ")
        case .queued:
            return job.waitingOnUpstream == true ? "Image service busy — nothing charged — tap to watch" : "Waiting to start — tap to watch"
        case .running:
            return job.waitingOnUpstream == true ? "Image service busy — nothing charged — tap to watch" : "Working on it — tap to watch"
        default:
            return "Credits returned — tap to see why"
        }
    }
}

/// The 6px dot before WORKING, pulsing over 1.4s.
struct PulsingDot: View {
    @State private var on = false
    var body: some View {
        Circle().fill(Theme.workingBadge).frame(width: 6, height: 6)
            .opacity(on ? 1 : 0.35)
            .animation(.easeInOut(duration: 1.4).repeatForever(autoreverses: true), value: on)
            .onAppear { on = true }
    }
}

/// The viewer: the library is as capable as the moment of delivery.
struct ViewerSheet: View {
    @Environment(\.dismiss) private var dismiss
    let job: JobSummary
    var onLeave: () -> Void

    var body: some View {
        SheetChrome(title: job.kind?.label ?? job.transformation,
                    sub: job.originalUrl == nil ? nil : "Drag the slider to compare.") {
            if let t = job.kind, let result = job.resultUrl {
                DeliveredResultBody(jobId: job.jobId, transformation: t, photoId: job.photoId,
                                    originalPath: job.originalUrl, urls: [result] + job.variants,
                                    wording: .viewer, onLeave: onLeave)
            }
            Button("Close") { dismiss() }.buttonStyle(GhostButtonStyle())
        }
        .presentationDetents([.large])
    }
}

/// A returned card must never be a dead end that just says FAILED.
struct ReturnedSheet: View {
    @Environment(\.dismiss) private var dismiss
    let job: JobSummary
    let rerun: (Transformation) async -> Void
    @State private var busy = false

    var body: some View {
        let status = job.jobStatus
        let kind = job.kind ?? .declutter
        SheetChrome(title: ReturnedJob.title(status)) {
            NoteBox { Text(job.note ?? ReturnedJob.defaultNote(status)) }
            Text(ReturnedJob.creditsBack).font(Theme.ui(14.5)).foregroundStyle(Theme.textSoft)
            if status == .rejected, kind == .declutter {
                Text(ReturnedJob.declutterHint).font(Theme.ui(13)).foregroundStyle(Theme.textFaint)
            }
            ForEach(ReturnedJob.choices(transformation: kind, status: status, hasPhoto: job.photoId != nil), id: \.title) { choice in
                Button {
                    guard !busy else { return }
                    busy = true
                    Task { await rerun(choice.transformation); dismiss() }
                } label: {
                    Text(choice.title)
                }
                .buttonStyle(choice.primary ? AnyButtonStyle(PrimaryButtonStyle()) : AnyButtonStyle(GhostButtonStyle()))
                .disabled(busy)
            }
            Button("Not now") { dismiss() }.buttonStyle(GhostButtonStyle())
        }
    }
}

/// Lets a `ForEach` pick a button style per row.
struct AnyButtonStyle: ButtonStyle {
    private let make: (Configuration) -> AnyView
    init<S: ButtonStyle>(_ style: S) { make = { AnyView(style.makeBody(configuration: $0)) } }
    func makeBody(configuration: Configuration) -> some View { make(configuration) }
}
