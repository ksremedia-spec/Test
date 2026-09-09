import SwiftUI

/// `What should we do to each?` — one row per photograph with its own fix,
/// because an agent working a listing has a mixed set. Jobs start one after
/// another; the queue is the progress screen.
struct BatchView: View {
    @Environment(AppSession.self) private var session
    @State private var error: String?
    @State private var starting = false

    private var flow: StudioFlow { session.flow }

    private var chosen: [BatchItem] { flow.items.filter { $0.chosen != nil } }
    private var totalCost: Int { chosen.reduce(0) { $0 + session.cost($1.chosen!) } }

    var body: some View {
        StudioPage {
            VStack(alignment: .leading, spacing: 14) {
                CardHeading(title: "What should we do to each?",
                            sub: "Choose a fix per photo, then start them together. Every result is checked before it reaches you; anything that doesn't pass gives the credits back.")
                VStack(spacing: 0) {
                    ForEach(flow.items) { item in
                        BatchRow(item: item, cost: session.cost)
                        if item.id != flow.items.last?.id { Rectangle().fill(Theme.line).frame(height: 1) }
                    }
                }
                if let message = error ?? affordabilityMessage { ErrorBox(message: message) }
                HStack(spacing: 10) {
                    Button("Start over") { flow.reset() }
                        .buttonStyle(GhostButtonStyle())
                        .disabled(starting)
                    Button {
                        Task { await startAll() }
                    } label: {
                        if starting { HStack(spacing: 8) { ButtonSpinner(); Text("Starting…") } } else { Text(startTitle) }
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .dimmedWhenDisabled(chosen.isEmpty || !affordable || starting)
                }
            }
            .card()
        }
        .navigationBarBackButtonHidden(true)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { CreditChip() } }
    }

    private var affordable: Bool { totalCost <= (session.balance ?? 0) }

    /// Checked here as well as on the server, so an agent is told BEFORE
    /// they wait rather than watching some of a batch start and the rest bounce.
    private var affordabilityMessage: String? {
        guard !chosen.isEmpty, !affordable else { return nil }
        return "That's \(totalCost) credits and you have \(session.balance ?? 0). Deselect one, or top up."
    }

    private var startTitle: String {
        if chosen.isEmpty { return "Start" }
        if !affordable { return "Not enough credits · needs \(totalCost)" }
        return "Start \(photosWord(chosen.count)) · \(creditsWord(totalCost))"
    }

    private func startAll() async {
        error = nil
        starting = true
        defer { starting = false }
        var failures: [String] = []
        var started = 0
        for item in chosen {
            guard let t = item.chosen else { continue }
            let request = JobRequest(photoId: item.photoId, transformation: t,
                                     style: t == .staging ? item.style : nil,
                                     roomType: t == .staging ? item.room : nil)
            do {
                let res: TransformResponse = try await session.api.post("/api/transform", request)
                session.balance = res.balance
                started += 1
            } catch let e as APIError {
                if e == .notSignedIn { return }
                failures.append("\(item.name) — \(e.message)")
            } catch {
                failures.append("\(item.name) — Something went wrong.")
            }
        }
        if started == 0 {
            error = failures.joined(separator: "; ")
            return
        }
        flow.batchNotice = failures.isEmpty ? nil
            : "Started, but \(failures.count) could not begin: \(failures.joined(separator: "; "))"
        flow.reset()
        session.selectedTab = .library
    }
}

/// One `.item` row: 74×56 thumbnail, the file name, the fix select, and the
/// style/room selects that appear only for staging.
struct BatchRow: View {
    @Bindable var item: BatchItem
    let cost: (Transformation) -> Int

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Group {
                if let image = item.preview {
                    Image(uiImage: image).resizable().scaledToFill()
                } else {
                    RemoteImage(path: item.originalPath)
                }
            }
            .frame(width: 74, height: 56)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 8) {
                Text(item.name).font(Theme.ui(13)).foregroundStyle(Theme.textFaint).lineLimit(1)
                Menu {
                    ForEach(item.offers) { t in
                        Button("\(t.label) · \(creditsWord(cost(t)))") { choose(t) }
                    }
                    Button("Skip this one") { item.fix = .skip }
                } label: {
                    HStack {
                        Text(fixTitle).font(Theme.ui(15)).foregroundStyle(fixColor)
                        Spacer()
                        Image(systemName: "chevron.down").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.textSoft)
                    }
                    .fieldChrome()
                }
                .accessibilityLabel("What to do with \(item.name)")
                if item.chosen == .staging {
                    ChoiceField(label: "Style", options: Catalog.stagingStyles, selection: $item.style)
                    ChoiceField(label: "Room type", options: Catalog.roomTypes, selection: $item.room)
                }
            }
        }
        .padding(.vertical, 12)
    }

    private func choose(_ t: Transformation) {
        item.fix = .run(t)
        if t == .staging {
            item.style = Catalog.stagingStyles[0]
            item.room = Catalog.roomTypes[0]
        }
    }

    private var fixTitle: String {
        switch item.fix {
        case .none: return "Choose a fix…"
        case .skip: return "Skip this one"
        case .run(let t): return "\(t.label) · \(creditsWord(cost(t)))"
        }
    }

    private var fixColor: Color {
        switch item.fix {
        case .none: return Theme.textFaint
        case .skip: return Theme.textSoft
        case .run: return Theme.pine
        }
    }
}
