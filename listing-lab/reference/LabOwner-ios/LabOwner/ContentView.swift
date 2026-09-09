import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var watch: Watch
    @State private var secret: String? = Secret.load()
    @State private var tab = 0

    var body: some View {
        if let secret {
            TabView(selection: $tab) {
                BoardTab(title: "Live", path: "/internal/board/live", secret: secret)
                    .tabItem { Label("Live", systemImage: "dot.radiowaves.left.and.right") }
                    .tag(0)
                BoardTab(title: "Board", path: "/internal/board", secret: secret)
                    .tabItem { Label("Board", systemImage: "chart.bar") }
                    .tag(1)
                BoardTab(title: "Promos", path: "/internal/board/promos", secret: secret)
                    .tabItem { Label("Promos", systemImage: "ticket") }
                    .tag(2)
                SettingsView(onSignOut: { self.secret = nil })
                    .tabItem { Label("Alerts", systemImage: "bell") }
                    .tag(3)
            }
            .tint(Color(red: 0x78/255, green: 0xAF/255, blue: 0xEB/255))
            .onChange(of: watch.openLiveRequested) { _, wants in
                if wants { tab = 0; watch.openLiveRequested = false }
            }
            .task { await watch.requestNotificationPermission() }
        } else {
            SecretEntryView { saved in self.secret = saved }
        }
    }
}

/// First launch: type the owner secret once. It is checked against the site
/// before it is kept.
struct SecretEntryView: View {
    var onSaved: (String) -> Void
    @State private var text = ""
    @State private var busy = false
    @State private var wrong = false

    var body: some View {
        VStack(spacing: 22) {
            Spacer()
            Text("Listing Lab").font(.system(size: 34, weight: .bold))
            Text("Owner access").foregroundStyle(.secondary)
            SecureField("Owner secret", text: $text)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .padding(14)
                .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
                .padding(.horizontal, 28)
            if wrong {
                Text("That secret didn't open the board. Check it and try again.")
                    .font(.footnote).foregroundStyle(.red).padding(.horizontal, 28)
            }
            Button {
                busy = true; wrong = false
                Task {
                    let v = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    if await Secret.verify(v) { Secret.save(v); onSaved(v) } else { wrong = true }
                    busy = false
                }
            } label: {
                if busy { ProgressView() } else { Text("Open the board").fontWeight(.semibold) }
            }
            .buttonStyle(.borderedProminent)
            .disabled(text.isEmpty || busy)
            Spacer()
            Text("Stored in this phone's Keychain. Nothing leaves the device except to thelistinglab.app.")
                .font(.caption2).foregroundStyle(.secondary).multilineTextAlignment(.center).padding(.horizontal, 40)
        }
        .padding(.bottom, 24)
        .background(Color(red: 0x0C/255, green: 0x11/255, blue: 0x18/255).ignoresSafeArea())
    }
}

struct SettingsView: View {
    @EnvironmentObject private var watch: Watch
    var onSignOut: () -> Void

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Toggle("Also tell me about deliveries", isOn: $watch.notifyDeliveries)
                } header: { Text("Alerts") } footer: {
                    Text("Refused and failed jobs always alert. While the app is open it checks every minute; in the background iOS runs the check on its own schedule — usually every 15 minutes to a couple of hours, more often for apps you use regularly.")
                }
                Section("Last check") {
                    LabeledContent("Checked", value: watch.lastChecked.map { $0.formatted(date: .omitted, time: .shortened) } ?? "—")
                    LabeledContent("Jobs in the last 24 hours", value: "\(watch.jobs.count)")
                    LabeledContent("Refused or failed", value: "\(watch.jobs.filter { $0.isBad }.count)")
                    if let p = watch.lastProblem { Text(p).foregroundStyle(.orange).font(.footnote) }
                    Button("Check now") { Task { await watch.check(source: "manual") } }
                }
                Section {
                    Button("Forget the secret", role: .destructive) { Secret.clear(); onSignOut() }
                }
            }
            .navigationTitle("Alerts")
        }
    }
}
