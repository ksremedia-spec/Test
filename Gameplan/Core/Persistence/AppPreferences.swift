import Foundation

/// Which data source the app is currently reading from.
enum DataSourceMode: String, Codable, CaseIterable, Sendable {
    /// A self-contained fictional league. Clearly labelled everywhere it is used.
    case demo
    /// The user's real ESPN league.
    case espn

    var displayName: String {
        switch self {
        case .demo: return "Demo league"
        case .espn: return "ESPN Fantasy"
        }
    }
}

/// Non-secret configuration the user has chosen. Secrets live in `SecureStore`.
struct AppPreferences: Codable, Equatable, Sendable {
    var hasCompletedOnboarding: Bool
    var dataSource: DataSourceMode
    var espnLeagueID: String?
    var espnTeamID: String?
    var season: Int?
    /// Base URL of a backend the user runs that proxies a language model.
    /// Absent by default, in which case the app writes its own explanations.
    var narrationEndpoint: String?
    var isNarrationEnabled: Bool
    var wantsLineupReminders: Bool
    var wantsWaiverReminders: Bool
    var wantsInjuryAlerts: Bool
    var lastPlanFingerprint: String?

    init(
        hasCompletedOnboarding: Bool = false,
        dataSource: DataSourceMode = .demo,
        espnLeagueID: String? = nil,
        espnTeamID: String? = nil,
        season: Int? = nil,
        narrationEndpoint: String? = nil,
        isNarrationEnabled: Bool = false,
        wantsLineupReminders: Bool = true,
        wantsWaiverReminders: Bool = true,
        wantsInjuryAlerts: Bool = true,
        lastPlanFingerprint: String? = nil
    ) {
        self.hasCompletedOnboarding = hasCompletedOnboarding
        self.dataSource = dataSource
        self.espnLeagueID = espnLeagueID
        self.espnTeamID = espnTeamID
        self.season = season
        self.narrationEndpoint = narrationEndpoint
        self.isNarrationEnabled = isNarrationEnabled
        self.wantsLineupReminders = wantsLineupReminders
        self.wantsWaiverReminders = wantsWaiverReminders
        self.wantsInjuryAlerts = wantsInjuryAlerts
        self.lastPlanFingerprint = lastPlanFingerprint
    }
}

/// Persists `AppPreferences`. Backed by `UserDefaults`, which is the right home
/// for a handful of non-sensitive settings.
protocol PreferencesStore: AnyObject, Sendable {
    func load() -> AppPreferences
    func save(_ preferences: AppPreferences)
}

final class UserDefaultsPreferencesStore: PreferencesStore, @unchecked Sendable {
    private let defaults: UserDefaults
    private let key = "com.gameplan.fantasy.preferences"
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func load() -> AppPreferences {
        guard
            let data = defaults.data(forKey: key),
            let preferences = try? decoder.decode(AppPreferences.self, from: data)
        else {
            return AppPreferences()
        }
        return preferences
    }

    func save(_ preferences: AppPreferences) {
        guard let data = try? encoder.encode(preferences) else { return }
        defaults.set(data, forKey: key)
    }
}

final class InMemoryPreferencesStore: PreferencesStore, @unchecked Sendable {
    private var preferences: AppPreferences
    private let lock = NSLock()

    init(preferences: AppPreferences = AppPreferences()) {
        self.preferences = preferences
    }

    func load() -> AppPreferences {
        lock.lock(); defer { lock.unlock() }
        return preferences
    }

    func save(_ preferences: AppPreferences) {
        lock.lock(); defer { lock.unlock() }
        self.preferences = preferences
    }
}
