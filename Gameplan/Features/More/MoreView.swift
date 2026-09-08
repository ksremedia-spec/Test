import SwiftUI

/// Settings: the league, the connection, notifications, the optional AI writer,
/// and the honest notes about where the data comes from.
@MainActor
struct MoreView: View {
    @Environment(AppModel.self) private var model
    @State private var showsESPNConnection = false
    @State private var showsDisconnectConfirmation = false
    @State private var isClearingCache = false

    var body: some View {
        NavigationStack {
            List {
                leagueSection
                connectionSection
                notificationsSection
                narrationSection
                dataSection
                aboutSection
            }
            .navigationTitle("More")
            .sheet(isPresented: $showsESPNConnection) {
                ESPNConnectionView(isOnboarding: false)
            }
            .confirmationDialog(
                "Disconnect and erase local data?",
                isPresented: $showsDisconnectConfirmation,
                titleVisibility: .visible
            ) {
                Button("Disconnect", role: .destructive) {
                    Task { await model.disconnect() }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This removes your stored ESPN session details, cached league data and every saved plan from this device.")
            }
        }
    }

    // MARK: - Sections

    @ViewBuilder
    private var leagueSection: some View {
        Section("League") {
            if let league = model.league {
                LabeledContent("Name", value: league.name)
                LabeledContent("Season", value: String(league.season))
                LabeledContent("Teams", value: "\(league.teamCount)")
                LabeledContent("Scoring", value: league.scoring.formatName)
                LabeledContent("Format", value: league.continuity.displayName)
                LabeledContent("Waivers", value: league.waivers.displayName)
                LabeledContent("Lineup", value: lineupDescription(league))
                LabeledContent("Bench", value: "\(league.benchSlots) spots")
                if league.injuredReserveSlots > 0 {
                    LabeledContent("IR", value: "\(league.injuredReserveSlots) spots")
                }
                LabeledContent("Playoffs", value: "\(league.playoffTeamCount) teams from week \(league.playoffStartWeek)")
            } else {
                Text("No league connected")
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func lineupDescription(_ league: League) -> String {
        league.startingSlots
            .sorted { $0.key.displayOrder < $1.key.displayOrder }
            .map { "\($0.value)\($0.key.displayName)" }
            .joined(separator: " · ")
    }

    private var connectionSection: some View {
        Section {
            HStack {
                Label(model.preferences.dataSource.displayName, systemImage: model.isDemoData ? "flask" : "link")
                Spacer()
                if model.isDemoData {
                    Text("Sample data")
                        .font(Theme.Typography.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Button("Connect ESPN league") { showsESPNConnection = true }

            if !model.isDemoData {
                Button("Switch to demo league") { model.switchToDemo() }
            }

            Button("Disconnect and erase data", role: .destructive) {
                showsDisconnectConfirmation = true
            }
        } header: {
            Text("Data source")
        } footer: {
            Text(model.isDemoData
                 ? "The demo league is fictional. The players, statistics and news in it are invented so you can try every screen without connecting an account."
                 : "Gameplan reads your league using ESPN's own read-only endpoints. Those endpoints are not a documented, supported API, so they can change without notice. Your session details stay in this device's Keychain and are sent only to ESPN.")
        }
    }

    private var notificationsSection: some View {
        Section {
            Toggle("Lineup reminders", isOn: Binding(
                get: { model.preferences.wantsLineupReminders },
                set: { model.setNotificationPreference(lineup: $0) }
            ))
            Toggle("Waiver reminders", isOn: Binding(
                get: { model.preferences.wantsWaiverReminders },
                set: { model.setNotificationPreference(waivers: $0) }
            ))
            Toggle("Plan changes", isOn: Binding(
                get: { model.preferences.wantsInjuryAlerts },
                set: { model.setNotificationPreference(injuries: $0) }
            ))
            Button("Enable notifications") {
                Task { await model.requestNotificationPermission() }
            }
        } header: {
            Text("Notifications")
        } footer: {
            Text("Gameplan only notifies you when something still needs a decision: an outstanding must-do move before kickoff, a waiver deadline with a recommendation attached, or news that changed your plan.")
        }
    }

    private var narrationSection: some View {
        Section {
            NavigationLink("AI explanations") {
                NarrationSettingsView()
            }
        } header: {
            Text("Analysis")
        } footer: {
            Text("By default Gameplan writes your plan on device, instantly and for free. You can point it at your own backend to have a language model write it instead.")
        }
    }

    private var dataSection: some View {
        Section {
            if let plan = model.plan {
                LabeledContent("Data quality", value: plan.dataQuality.descriptor)
                LabeledContent("Last analyzed", value: plan.generatedAt.formatted(date: .abbreviated, time: .shortened))
                ForEach(plan.dataQuality.notes, id: \.self) { note in
                    Text(note)
                        .font(Theme.Typography.caption)
                        .foregroundStyle(.secondary)
                }
            }
            NavigationLink("Diagnostics") {
                DiagnosticsView()
            }
            Button("Clear cached data") {
                isClearingCache = true
                Task {
                    await model.clearCache()
                    isClearingCache = false
                }
            }
            .disabled(isClearingCache)
        } header: {
            Text("Data")
        }
    }

    private var aboutSection: some View {
        Section {
            NavigationLink("How Gameplan decides") {
                MethodologyView()
            }
            LabeledContent("Version", value: appVersion)
        } header: {
            Text("About")
        } footer: {
            Text("Gameplan is an independent companion app. It isn't affiliated with, endorsed by, or connected to ESPN or the NFL.")
        }
    }

    private var appVersion: String {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1"
        return "\(version) (\(build))"
    }
}

/// Settings for the optional language-model writer.
@MainActor
struct NarrationSettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var endpoint: String = ""
    @State private var token: String = ""
    @State private var isEnabled = false

    var body: some View {
        Form {
            Section {
                Toggle("Use a language model", isOn: $isEnabled)
                TextField("https://your-backend.example/narrate", text: $endpoint)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                SecureField("Bearer token (optional)", text: $token)
            } header: {
                Text("Endpoint")
            } footer: {
                Text("Gameplan never stores a model API key. It posts the week's evidence to a backend you control, and that backend holds the key. Only HTTPS endpoints are accepted.")
            }

            Section {
                Button("Save") {
                    model.setNarration(
                        endpoint: endpoint,
                        token: token.isEmpty ? nil : token,
                        enabled: isEnabled
                    )
                }
                .disabled(isEnabled && endpoint.isEmpty)
            } footer: {
                Text("Whatever the model writes is checked against the evidence before you see it. Any figure that isn't in the data is rejected and Gameplan's own wording is used instead.")
            }
        }
        .navigationTitle("AI explanations")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            endpoint = model.preferences.narrationEndpoint ?? ""
            isEnabled = model.preferences.isNarrationEnabled
        }
    }
}

/// A plain-language explanation of the engine, for anyone who wants to audit it.
struct MethodologyView: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.large) {
                block(
                    "The objective",
                    "Gameplan doesn't try to maximize your projected points. It tries to maximize your chance of winning this week's matchup, which is a different thing. If you're already likely to win, a safe player is worth more than a risky one with the same projection. If you're likely to lose, the opposite is true. Every lineup recommendation comes out of that calculation rather than from a rule of thumb."
                )
                block(
                    "How players are projected",
                    "When your league publishes a projection, Gameplan starts from it. When it doesn't, the projection is calculated from the player's own recent usage. Either way, the app then estimates a range — a floor and a ceiling — from how much that player's scoring has actually varied week to week, widened when there's an injury question. The range is what makes floor-versus-ceiling advice possible."
                )
                block(
                    "How the matchup is scored",
                    "Your lineup's total and your opponent's are each treated as a distribution rather than a single number, with a small allowance for the fact that players on the same team score together. The win probability is the chance your distribution lands above theirs. Gameplan always assumes your opponent starts their best legal lineup, so it never flatters your position."
                )
                block(
                    "How waivers are ranked",
                    "Not by projection. Each available player is scored by how much they'd actually add to your starting lineup, how far clear of replacement level they are in a league of your size, whether they fix your weakest position, and how stable their role looks. A player who'd sit on your bench scores low no matter how good they are."
                )
                block(
                    "What the app won't claim",
                    "Every number in the app is labelled with where it came from: measured from your league's data, calculated by Gameplan, or estimated by a model where data was missing. Trade ideas are directions to explore, not valuations — what a manager will accept isn't in any dataset. Suggested waiver bids are recommendations, not market prices."
                )
                block(
                    "If a language model writes your plan",
                    "The model only ever sees a structured pack of verified facts, and it's instructed never to introduce a statistic it wasn't given. Before you see the result, every number in it is checked against that pack. If anything doesn't match, the response is discarded and Gameplan's own wording is shown instead."
                )
            }
            .screenPadding()
            .padding(.vertical, Theme.Spacing.large)
        }
        .background(Theme.Palette.background)
        .navigationTitle("How Gameplan decides")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func block(_ title: String, _ body: String) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.small) {
            Text(title)
                .font(Theme.Typography.title)
            Text(body)
                .font(Theme.Typography.body)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
