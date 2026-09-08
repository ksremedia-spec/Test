import Foundation
import Observation

/// What the primary screens are currently showing.
enum LoadState: Equatable {
    case idle
    case loading(AnalysisStage?)
    case loaded
    case failed(AppError)

    var isLoading: Bool {
        if case .loading = self { return true }
        return false
    }

    var error: AppError? {
        if case .failed(let error) = self { return error }
        return nil
    }
}

/// A failure the user can be shown, phrased in terms of what they can do next.
struct AppError: Equatable, Identifiable {
    var id = UUID()
    var title: String
    var message: String
    var suggestion: String?
    var requiresCredentials: Bool
    var isRetryable: Bool

    static func from(_ error: Error) -> AppError {
        if let fantasyError = error as? FantasyDataError {
            return AppError(
                title: fantasyError.errorDescription ?? "Something went wrong",
                message: fantasyError.recoverySuggestion ?? "",
                suggestion: nil,
                requiresCredentials: fantasyError.requiresCredentials,
                isRetryable: !fantasyError.requiresCredentials
            )
        }
        return AppError(
            title: "Something went wrong",
            message: error.localizedDescription,
            suggestion: nil,
            requiresCredentials: false,
            isRetryable: true
        )
    }

    static func == (lhs: AppError, rhs: AppError) -> Bool {
        lhs.title == rhs.title && lhs.message == rhs.message
    }
}

/// Owns the app's state and every transition between screens.
///
/// It is the only object the views talk to, which keeps the views free of
/// networking, caching and analysis concerns and makes the whole flow readable in
/// one file.
@MainActor
@Observable
final class AppModel {
    private(set) var preferences: AppPreferences
    private(set) var snapshot: LeagueSnapshot?
    private(set) var analysis: WeeklyAnalysis?
    private(set) var loadState: LoadState = .idle
    private(set) var availableLeagues: [LeagueSummary] = []
    private(set) var availableTeams: [TeamSummary] = []
    private(set) var isConnecting = false
    private(set) var connectionError: AppError?

    /// Set when the last refresh introduced a must-do move that was not there
    /// before, so the UI can draw attention to it once.
    private(set) var newUrgentMoves: [Recommendation] = []

    var environment: AppEnvironment
    private let notifications: NotificationScheduler
    private var loadTask: Task<Void, Never>?
    /// Onboarding runs the first analysis before the main interface appears, so
    /// loading has to be permitted slightly before onboarding is marked complete.
    private var allowsLoading = false

    init(environment: AppEnvironment = AppEnvironment()) {
        self.environment = environment
        self.preferences = environment.preferencesStore.load()
        self.notifications = NotificationScheduler()
    }

    // MARK: - Derived state

    var plan: GamePlan? { analysis?.plan }
    var league: League? { snapshot?.league }
    var week: Int { snapshot?.week ?? environment.calendar.estimatedWeek() }
    var isDemoData: Bool { snapshot?.isDemo ?? (preferences.dataSource == .demo) }
    var needsOnboarding: Bool { !preferences.hasCompletedOnboarding }

    var seasonPhase: SeasonPhase {
        guard let league = snapshot?.league else { return .regularSeason }
        // The demo league always presents the in-season experience, which is the
        // product's centre of gravity.
        if snapshot?.isDemo == true { return .regularSeason }
        return environment.calendar.phase(week: week, league: league)
    }

    func analyzedPlayer(for id: PlayerID) -> AnalyzedPlayer? {
        analysis?.player(for: id)
    }

    // MARK: - Loading

    /// Loads everything for the current league. Safe to call repeatedly; a second
    /// call while one is in flight replaces it rather than stacking.
    func load(force: Bool = false) {
        loadTask?.cancel()
        loadTask = Task { await performLoad(force: force) }
    }

    func refresh() async {
        await performLoad(force: true)
    }

    private func performLoad(force: Bool) async {
        guard preferences.hasCompletedOnboarding || allowsLoading else { return }
        guard let leagueID = resolvedLeagueID, let teamID = resolvedTeamID else {
            loadState = .failed(AppError.from(FantasyDataError.notConfigured))
            return
        }

        loadState = .loading(nil)
        let service = environment.analysisService(for: preferences)
        // "New" only means new relative to a plan the user has already seen. On the
        // very first analysis everything is new, and notifying about all of it
        // would be exactly the kind of noise this app is supposed to remove.
        let hadPreviousPlan = analysis != nil
        let previousUrgentIDs = Set((analysis?.plan.urgentMoves ?? []).map(\.id))

        do {
            let snapshot = try await service.loadSnapshot(
                leagueID: leagueID,
                teamID: teamID,
                season: preferences.season,
                week: nil,
                allowCache: !force
            )
            guard !Task.isCancelled else { return }
            self.snapshot = snapshot

            let analysis = await service.analyze(
                snapshot: snapshot,
                allowCache: !force,
                onStage: { [weak self] stage in
                    Task { @MainActor in
                        guard let self, self.loadState.isLoading else { return }
                        self.loadState = .loading(stage)
                    }
                }
            )
            guard !Task.isCancelled else { return }

            self.analysis = analysis
            self.loadState = .loaded
            self.newUrgentMoves = hadPreviousPlan
                ? analysis.plan.urgentMoves.filter { !previousUrgentIDs.contains($0.id) }
                : []

            update { $0.lastPlanFingerprint = analysis.plan.inputFingerprint }
            await scheduleNotifications(for: analysis)
        } catch {
            guard !Task.isCancelled else { return }
            AppLog.analysis.error("Load failed: \(error.localizedDescription, privacy: .public)")
            loadState = .failed(AppError.from(error))
        }
    }

    private func scheduleNotifications(for analysis: WeeklyAnalysis) async {
        guard let league = snapshot?.league else { return }
        await notifications.reschedule(
            for: analysis.plan,
            preferences: preferences,
            lineupDeadline: snapshot?.matchup.lineupLockDate ?? environment.calendar.sundayKickoff(),
            waiverDeadline: environment.calendar.nextWaiverProcessing(weekday: league.waiverProcessingDay)
        )
        if !newUrgentMoves.isEmpty {
            await notifications.notifyPlanChanged(newUrgentMoves: newUrgentMoves, preferences: preferences)
        }
    }

    func acknowledgeNewMoves() {
        newUrgentMoves = []
    }

    // MARK: - Onboarding and connection

    func startDemo() {
        update {
            $0.dataSource = .demo
            $0.espnLeagueID = DemoLeague.leagueID
            $0.espnTeamID = DemoLeague.userTeamID
            $0.season = nil
        }
        connectionError = nil
    }

    /// Validates ESPN credentials and league by actually reading the league.
    /// Nothing is persisted unless the read succeeds.
    func connectESPN(leagueID: String, espnS2: String, swid: String) async -> Bool {
        isConnecting = true
        connectionError = nil
        defer { isConnecting = false }

        let trimmedLeague = leagueID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedLeague.isEmpty else {
            connectionError = AppError(
                title: "Enter your league ID",
                message: "You'll find it in your ESPN league URL, after leagueId=.",
                suggestion: nil,
                requiresCredentials: false,
                isRetryable: true
            )
            return false
        }

        do {
            try environment.secureStore.set(espnS2.trimmingCharacters(in: .whitespacesAndNewlines), for: .espnS2)
            try environment.secureStore.set(swid.trimmingCharacters(in: .whitespacesAndNewlines), for: .espnSWID)
        } catch {
            connectionError = AppError.from(error)
            return false
        }

        var candidate = preferences
        candidate.dataSource = .espn
        candidate.espnLeagueID = trimmedLeague
        let season = candidate.season ?? environment.calendar.season
        let provider = environment.fantasyProvider(for: candidate)

        do {
            _ = try await provider.league(id: trimmedLeague, season: season)
            let teams = try await provider.teams(leagueID: trimmedLeague, season: season)
            availableTeams = teams
            update {
                $0.dataSource = .espn
                $0.espnLeagueID = trimmedLeague
                $0.season = season
                $0.espnTeamID = nil
            }
            return true
        } catch {
            connectionError = AppError.from(error)
            return false
        }
    }

    func selectTeam(id: String) {
        update { $0.espnTeamID = id }
    }

    /// Unlocks loading during onboarding without leaving the onboarding flow.
    func completeOnboardingSilently() {
        allowsLoading = true
    }

    func completeOnboarding() {
        allowsLoading = true
        update { $0.hasCompletedOnboarding = true }
        if analysis == nil { load(force: true) }
    }

    func requestNotificationPermission() async -> Bool {
        await notifications.requestAuthorization()
    }

    // MARK: - Settings

    func setNotificationPreference(lineup: Bool? = nil, waivers: Bool? = nil, injuries: Bool? = nil) {
        update {
            if let lineup { $0.wantsLineupReminders = lineup }
            if let waivers { $0.wantsWaiverReminders = waivers }
            if let injuries { $0.wantsInjuryAlerts = injuries }
        }
        if let analysis { Task { await scheduleNotifications(for: analysis) } }
    }

    func setNarration(endpoint: String?, token: String?, enabled: Bool) {
        let trimmed = endpoint?.trimmingCharacters(in: .whitespacesAndNewlines)
        try? environment.secureStore.set(token?.isEmpty == true ? nil : token, for: .narrationToken)
        update {
            $0.narrationEndpoint = (trimmed?.isEmpty ?? true) ? nil : trimmed
            $0.isNarrationEnabled = enabled && !(trimmed?.isEmpty ?? true)
        }
    }

    func switchToDemo() {
        startDemo()
        load(force: true)
    }

    /// Clears every stored secret, cached response and preference.
    func disconnect() async {
        try? environment.secureStore.removeAll()
        await environment.cache.removeAll()
        notifications.cancelAll()
        snapshot = nil
        analysis = nil
        availableTeams = []
        availableLeagues = []
        loadState = .idle
        allowsLoading = false
        preferences = AppPreferences()
        environment.preferencesStore.save(preferences)
    }

    func clearCache() async {
        await environment.cache.removeAll()
        await refresh()
    }

    // MARK: - Helpers

    private var resolvedLeagueID: String? {
        preferences.dataSource == .demo ? DemoLeague.leagueID : preferences.espnLeagueID
    }

    private var resolvedTeamID: String? {
        preferences.dataSource == .demo ? DemoLeague.userTeamID : preferences.espnTeamID
    }

    private func update(_ transform: (inout AppPreferences) -> Void) {
        var copy = preferences
        transform(&copy)
        preferences = copy
        environment.preferencesStore.save(copy)
    }
}
