import Foundation

/// Composition root.
///
/// Everything the app depends on is assembled here and injected downward, so any
/// piece can be replaced for tests or previews without touching the code that
/// uses it. Nothing below this file reaches for a singleton.
struct AppEnvironment: Sendable {
    var preferencesStore: PreferencesStore
    var secureStore: SecureStore
    var cache: Cache
    var calendar: SeasonCalendar
    /// Injectable so tests can supply a stub session.
    var urlSession: URLSession

    init(
        preferencesStore: PreferencesStore = UserDefaultsPreferencesStore(),
        secureStore: SecureStore = KeychainSecureStore(),
        cache: Cache = FileCache(),
        calendar: SeasonCalendar = SeasonCalendar(),
        urlSession: URLSession = .shared
    ) {
        self.preferencesStore = preferencesStore
        self.secureStore = secureStore
        self.cache = cache
        self.calendar = calendar
        self.urlSession = urlSession
    }

    /// The data provider implied by the user's current settings.
    func fantasyProvider(for preferences: AppPreferences) -> FantasyDataProvider {
        switch preferences.dataSource {
        case .demo:
            return DemoFantasyProvider(now: calendar.now)
        case .espn:
            return ESPNFantasyProvider(
                client: ESPNClient(secureStore: secureStore),
                secureStore: secureStore
            )
        }
    }

    func researchProvider(for preferences: AppPreferences) -> ResearchProvider {
        switch preferences.dataSource {
        case .demo:
            // The demo carries its own conditions so it works with no network.
            return DemoResearchProvider()
        case .espn:
            return CompositeResearchProvider([
                OpenMeteoWeatherProvider(session: urlSession)
            ])
        }
    }

    /// Facts about the NFL rather than about a league: the week's games, the
    /// betting line, depth charts and the injury report.
    ///
    /// The demo league carries its own schedule, so it needs none of this and
    /// stays entirely offline.
    func contextProvider(for preferences: AppPreferences) -> NFLContextProvider {
        switch preferences.dataSource {
        case .demo:
            return EmptyNFLContextProvider()
        case .espn:
            return ESPNPublicProvider(session: urlSession)
        }
    }

    /// The remote narrator when the user has configured and enabled one,
    /// otherwise the on-device writer.
    func narrator(for preferences: AppPreferences) -> NarrationProvider {
        guard
            preferences.isNarrationEnabled,
            let endpoint = preferences.narrationEndpoint,
            let url = URL(string: endpoint),
            url.scheme?.lowercased() == "https"
        else {
            return TemplateNarrator()
        }
        return RemoteNarrator(
            endpoint: url,
            token: secureStore.string(for: .narrationToken),
            session: urlSession
        )
    }

    func analysisService(for preferences: AppPreferences) -> AnalysisService {
        AnalysisService(
            fantasyProvider: fantasyProvider(for: preferences),
            researchProvider: researchProvider(for: preferences),
            contextProvider: contextProvider(for: preferences),
            narrator: narrator(for: preferences),
            cache: cache,
            calendar: calendar
        )
    }

    /// A fully in-memory environment for previews and tests.
    static func preview(preferences: AppPreferences = AppPreferences(hasCompletedOnboarding: true)) -> AppEnvironment {
        AppEnvironment(
            preferencesStore: InMemoryPreferencesStore(preferences: preferences),
            secureStore: InMemorySecureStore(),
            cache: NullCache(),
            calendar: SeasonCalendar()
        )
    }
}
