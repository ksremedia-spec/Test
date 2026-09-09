import SwiftUI

/// `What should we do to it?` — one photo, the offered transformations only
/// (unoffered ones are not rendered, never greyed), style and room for
/// staging, and one Start button that says the price.
struct PickView: View {
    @Environment(AppSession.self) private var session
    @State private var error: String?
    @State private var starting = false

    private var flow: StudioFlow { session.flow }

    var body: some View {
        StudioPage {
            if let item = flow.pick {
                PickCard(item: item, error: $error, starting: $starting, start: { await start(item) }, back: { flow.reset() })
            }
        }
        .navigationBarBackButtonHidden(true)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { CreditChip() } }
    }

    /// A timeout here is ambiguous — the job may have started and been
    /// charged — so there is no blind re-tap: the person is sent to My
    /// photos, where the real state lives.
    private func start(_ item: BatchItem) async {
        guard let t = item.chosen else { return }
        error = nil
        starting = true
        defer { starting = false }
        let request = JobRequest(photoId: item.photoId, transformation: t,
                                 style: t == .staging ? item.style : nil,
                                 roomType: t == .staging ? item.room : nil)
        do {
            let res: TransformResponse = try await session.api.post("/api/transform", request)
            session.balance = res.balance
            let ctx = RunContext(jobId: res.jobId, transformation: t, photoId: item.photoId,
                                 originalPath: item.originalPath, startedAt: Date())
            flow.path = [.run(ctx)]
        } catch let e as APIError {
            if e.isRetryable {
                error = "\(e.message) If it doesn't appear in My Photos in a moment, try again."
                session.selectedTab = .library
            } else if e.code == "INSUFFICIENT_CREDITS" {
                error = "Not enough credits for that one."
            } else if e != .notSignedIn {
                error = e.message
            }
        } catch {
            self.error = "Something went wrong."
        }
    }
}

/// The card itself, with the item bound so the option grid and the selects can write to it.
private struct PickCard: View {
    @Environment(AppSession.self) private var session
    @Bindable var item: BatchItem
    @Binding var error: String?
    @Binding var starting: Bool
    let start: () async -> Void
    let back: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            CardHeading(title: "What should we do to it?",
                        sub: "Every result is checked before it reaches you. If nothing passes, your credits come back.")
            preview
            OptionGrid(item: item, cost: session.cost)
            if item.chosen == .staging {
                ChoiceField(label: "Style", options: Catalog.stagingStyles, selection: $item.style)
                ChoiceField(label: "Room type", options: Catalog.roomTypes, selection: $item.room)
            }
            if let error { ErrorBox(message: error) }
            HStack(spacing: 10) {
                Button("Back") { back() }
                    .buttonStyle(GhostButtonStyle())
                    .disabled(starting)
                startButton
            }
        }
        .card()
    }

    private var preview: some View {
        Group {
            if let image = item.preview {
                Image(uiImage: image).resizable().scaledToFit()
            } else {
                RemoteImage(path: item.originalPath, contentMode: .fit)
            }
        }
        .frame(maxWidth: .infinity)
        .background(Theme.surface3)
        .clipShape(RoundedRectangle(cornerRadius: Theme.rMd))
        .accessibilityLabel("The photo you uploaded")
    }

    private var startButton: some View {
        let chosen = item.chosen
        let cost = chosen.map(session.cost) ?? 0
        let affordable = chosen != nil && (session.balance ?? 0) >= cost
        return Button {
            Task { await start() }
        } label: {
            if starting {
                HStack(spacing: 8) { ButtonSpinner(); Text("Starting") }
            } else if chosen == nil {
                Text("Start")
            } else if affordable {
                Text("Start · \(creditsWord(cost))")
            } else {
                Text("Not enough credits")
            }
        }
        .buttonStyle(PrimaryButtonStyle())
        .dimmedWhenDisabled(chosen == nil || !affordable || starting)
    }
}

/// The 2-column grid of `.opt` buttons: label, then `<cost> credit(s) · <advice>`.
struct OptionGrid: View {
    @Bindable var item: BatchItem
    let cost: (Transformation) -> Int

    var body: some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
            ForEach(item.offers) { t in
                let selected = item.chosen == t
                Button {
                    item.fix = .run(t)
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(t.label)
                            .font(Theme.ui(15, weight: .semibold))
                            .foregroundStyle(Theme.text)
                        Text(costLine(t))
                            .font(Theme.ui(12.5))
                            .foregroundStyle(selected ? Theme.brassSoft : Theme.textFaint)
                            .lineSpacing(2)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(14)
                    .background(selected ? Theme.pineDeep : Theme.surface2, in: RoundedRectangle(cornerRadius: Theme.rSm))
                    .overlay(RoundedRectangle(cornerRadius: Theme.rSm).stroke(selected ? Theme.pine : Theme.line, lineWidth: 1))
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
    }

    private func costLine(_ t: Transformation) -> String {
        var line = creditsWord(cost(t))
        if let advice = item.advice[t] { line += " · \(advice)" }
        return line
    }
}

/// A `<select>`: label above, the current value with a chevron, a menu of the closed list.
struct ChoiceField: View {
    let label: String
    let options: [String]
    @Binding var selection: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            FieldLabel(text: label)
            Menu {
                ForEach(options, id: \.self) { option in
                    Button(option) { selection = option }
                }
            } label: {
                HStack {
                    Text(selection).font(Theme.ui(16)).foregroundStyle(Theme.text)
                    Spacer()
                    Image(systemName: "chevron.down").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.textSoft)
                }
                .fieldChrome()
            }
            .accessibilityLabel(label)
        }
    }
}
