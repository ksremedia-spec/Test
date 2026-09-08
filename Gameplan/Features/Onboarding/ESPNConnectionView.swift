import SwiftUI

/// Collects the ESPN league ID and, for private leagues, the two session cookies.
///
/// The app deliberately never asks for an ESPN username or password: there is no
/// supported way to exchange those for read access, and asking for them would
/// train users into a habit worth discouraging. The cookies are stored in the
/// Keychain and sent only to ESPN.
@MainActor
struct ESPNConnectionView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var isOnboarding: Bool
    var onConnected: (() -> Void)? = nil

    @State private var leagueID = ""
    @State private var espnS2 = ""
    @State private var swid = ""
    @State private var showsHelp = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("League ID", text: $leagueID)
                        .keyboardType(.numberPad)
                        .textInputAutocapitalization(.never)
                } header: {
                    Text("Your league")
                } footer: {
                    Text("Open your league on ESPN. The ID is the number in the address after leagueId=.")
                }

                Section {
                    SecureField("espn_s2", text: $espnS2)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("SWID", text: $swid)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button("Where do I find these?") { showsHelp = true }
                        .font(Theme.Typography.caption)
                } header: {
                    Text("Private leagues only")
                } footer: {
                    Text("Leave these empty if your league is public. They're stored in this device's Keychain, never logged, and sent only to ESPN.")
                }

                if let error = model.connectionError {
                    Section {
                        VStack(alignment: .leading, spacing: Theme.Spacing.tight) {
                            Text(error.title)
                                .font(Theme.Typography.rowTitle)
                                .foregroundStyle(Theme.Palette.negative)
                            if !error.message.isEmpty {
                                Text(error.message)
                                    .font(Theme.Typography.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }

                if !model.availableTeams.isEmpty {
                    Section("Which team is yours?") {
                        ForEach(model.availableTeams) { team in
                            Button {
                                model.selectTeam(id: team.id)
                                finish()
                            } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(team.name)
                                            .font(Theme.Typography.rowTitle)
                                            .foregroundStyle(.primary)
                                        Text([team.ownerName, team.recordLabel].compactMap { $0 }.joined(separator: " · "))
                                            .font(Theme.Typography.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    if model.preferences.espnTeamID == team.id {
                                        Image(systemName: "checkmark")
                                            .foregroundStyle(Theme.Palette.accent)
                                    }
                                }
                            }
                        }
                    }
                }

                Section {
                    Button {
                        Task { await connect() }
                    } label: {
                        HStack {
                            if model.isConnecting { ProgressView().controlSize(.small) }
                            Text(model.availableTeams.isEmpty ? "Connect" : "Reconnect")
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .disabled(leagueID.isEmpty || model.isConnecting)
                }
            }
            .navigationTitle("ESPN Fantasy")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(isOnboarding ? "Back" : "Done") { dismiss() }
                }
            }
            .sheet(isPresented: $showsHelp) { ESPNCredentialHelpView() }
            .onAppear {
                leagueID = model.preferences.espnLeagueID ?? ""
            }
        }
    }

    private func connect() async {
        let connected = await model.connectESPN(leagueID: leagueID, espnS2: espnS2, swid: swid)
        // A single-team league would be unusual, but if there is only one choice
        // there is no decision to make.
        if connected, model.availableTeams.count == 1, let only = model.availableTeams.first {
            model.selectTeam(id: only.id)
            finish()
        }
    }

    private func finish() {
        if let onConnected {
            onConnected()
        } else {
            model.load(force: true)
            dismiss()
        }
    }
}

/// Step-by-step instructions for retrieving the two cookies.
struct ESPNCredentialHelpView: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.large) {
                    Text("ESPN doesn't publish a supported way for other apps to read a private league. The workaround the fantasy community uses is to copy two cookies from a browser you're already signed in to.")
                        .font(Theme.Typography.body)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)

                    step(1, "Sign in to fantasy.espn.com in a desktop browser.")
                    step(2, "Open the browser's developer tools and find the stored cookies for espn.com.")
                    step(3, "Copy the value of espn_s2. It's a long string.")
                    step(4, "Copy the value of SWID. It looks like {ABCD1234-…}. Gameplan adds the braces if you leave them off.")
                    step(5, "Paste both here. They stay in this device's Keychain.")

                    VStack(alignment: .leading, spacing: Theme.Spacing.small) {
                        Text("Worth knowing")
                            .font(Theme.Typography.title)
                        Text("These cookies expire, so you may need to repeat this occasionally. Because the endpoints aren't a documented API, ESPN can change them at any time. If that happens, Gameplan's data layer is isolated behind a single interface, so switching to another source doesn't affect the rest of the app — and the demo league keeps working in the meantime.")
                            .font(Theme.Typography.body)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .screenPadding()
                .padding(.vertical, Theme.Spacing.large)
            }
            .background(Theme.Palette.background)
            .navigationTitle("Finding your cookies")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private func step(_ number: Int, _ text: String) -> some View {
        HStack(alignment: .top, spacing: Theme.Spacing.medium) {
            Text("\(number)")
                .font(Theme.Typography.metric(.footnote))
                .foregroundStyle(Theme.Palette.accent)
                .frame(width: 20, alignment: .leading)
            Text(text)
                .font(Theme.Typography.body)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }
}
