import Foundation

/// The connected league, its current week, and this week's raw data.
struct LeagueSnapshot: Sendable {
    var league: League
    var week: Int
    var matchup: Matchup
    var waiverPool: [PlayerContext]
    var isDemo: Bool
    var fetchedAt: Date
}

/// Coordinates data loading, research enrichment, analysis and caching.
///
/// Cost control is a first-class concern here. Deterministic analysis is cheap
/// and always runs; the language model is expensive and runs only when the
/// situation fingerprint actually changed. Opening the same screen twice, or
/// switching tabs, never triggers either.
struct AnalysisService: Sendable {
    var fantasyProvider: FantasyDataProvider
    var researchProvider: ResearchProvider
    var narrator: NarrationProvider
    var cache: Cache
    var calendar: SeasonCalendar

    init(
        fantasyProvider: FantasyDataProvider,
        researchProvider: ResearchProvider = EmptyResearchProvider(),
        narrator: NarrationProvider = TemplateNarrator(),
        cache: Cache,
        calendar: SeasonCalendar = SeasonCalendar()
    ) {
        self.fantasyProvider = fantasyProvider
        self.researchProvider = researchProvider
        self.narrator = narrator
        self.cache = cache
        self.calendar = calendar
    }

    // MARK: - Loading

    func loadSnapshot(
        leagueID: String,
        teamID: String,
        season: Int?,
        week explicitWeek: Int?,
        allowCache: Bool = true
    ) async throws -> LeagueSnapshot {
        let resolvedSeason = season ?? calendar.season

        let league = try await cached(
            key: "league-\(leagueID)-\(resolvedSeason)",
            lifetime: CacheLifetime.leagueSettings,
            allowCache: allowCache
        ) {
            try await fantasyProvider.league(id: leagueID, season: resolvedSeason)
        }

        let week: Int
        if let explicitWeek {
            week = explicitWeek
        } else {
            week = (try? await fantasyProvider.currentWeek(leagueID: leagueID, season: resolvedSeason))
                ?? calendar.estimatedWeek(season: resolvedSeason)
        }

        var matchup = try await cached(
            key: "matchup-\(leagueID)-\(resolvedSeason)-\(week)-\(teamID)",
            lifetime: CacheLifetime.matchup,
            allowCache: allowCache
        ) {
            try await fantasyProvider.matchup(
                leagueID: leagueID,
                season: resolvedSeason,
                week: week,
                teamID: teamID
            )
        }

        // The waiver pool is optional context: a provider that cannot supply it
        // should cost the user their waiver advice, not their game plan.
        let loadedPool: [PlayerContext]? = await cachedOptional(
            key: "waivers-\(leagueID)-\(resolvedSeason)-\(week)",
            lifetime: CacheLifetime.waiverPool,
            allowCache: allowCache
        ) {
            try await fantasyProvider.freeAgents(
                leagueID: leagueID,
                season: resolvedSeason,
                week: week,
                limit: 60
            )
        }
        var waiverPool = loadedPool ?? []

        // Research enrichment is best-effort. A failure here degrades the
        // explanation, it does not fail the load.
        let enriched = await enrich(matchup: matchup, waiverPool: waiverPool, week: week)
        matchup = enriched.matchup
        waiverPool = enriched.waiverPool

        return LeagueSnapshot(
            league: league,
            week: week,
            matchup: matchup,
            waiverPool: waiverPool,
            isDemo: fantasyProvider.isDemo,
            fetchedAt: Date()
        )
    }

    // MARK: - Analysis

    /// Runs the engine, reusing a cached plan when nothing meaningful changed.
    func analyze(
        snapshot: LeagueSnapshot,
        allowCache: Bool = true,
        onStage: ((AnalysisStage) -> Void)? = nil
    ) async -> WeeklyAnalysis {
        let fingerprint = Fingerprint.forAnalysis(
            league: snapshot.league,
            matchup: snapshot.matchup,
            waiverPool: snapshot.waiverPool
        )
        let cacheKey = "plan-\(snapshot.league.id)-\(snapshot.week)-\(fingerprint)"

        // Only the finished plan is cached, not the whole analysis: the rest is
        // cheap to recompute and keeping it small keeps the cache honest.
        if allowCache, let cachedPlan = await cache.value(forKey: cacheKey, as: GamePlan.self) {
            AppLog.analysis.debug("Reusing cached game plan")
            let recomputed = await runEngine(snapshot: snapshot, narrator: TemplateNarrator(), onStage: nil)
            var analysis = recomputed
            analysis.plan = cachedPlan
            return analysis
        }

        let analysis = await runEngine(snapshot: snapshot, narrator: narrator, onStage: onStage)
        await cache.store(analysis.plan, forKey: cacheKey, lifetime: CacheLifetime.analysis)
        return analysis
    }

    private func runEngine(
        snapshot: LeagueSnapshot,
        narrator: NarrationProvider,
        onStage: ((AnalysisStage) -> Void)?
    ) async -> WeeklyAnalysis {
        let builder = GamePlanBuilder(
            league: snapshot.league,
            week: snapshot.week,
            narrator: narrator,
            calendar: calendar
        )
        return await builder.build(
            matchup: snapshot.matchup,
            waiverPool: snapshot.waiverPool,
            onStage: onStage
        )
    }

    // MARK: - Research enrichment

    /// Attaches news and weather to the player contexts that need them.
    private func enrich(
        matchup: Matchup,
        waiverPool: [PlayerContext],
        week: Int
    ) async -> (matchup: Matchup, waiverPool: [PlayerContext]) {
        let allContexts = matchup.userTeam.roster.map(\.context)
            + (matchup.opponentTeam?.roster ?? []).map(\.context)
            + waiverPool

        let games = Set(allContexts.compactMap { context -> ScheduledGame? in
            guard let environment = context.environment else { return nil }
            let home = environment.isHome ? context.player.teamAbbreviation : environment.opponentAbbreviation
            let away = environment.isHome ? environment.opponentAbbreviation : context.player.teamAbbreviation
            return ScheduledGame(
                homeTeamAbbreviation: home,
                awayTeamAbbreviation: away,
                kickoff: environment.kickoff,
                week: week
            )
        })

        guard !games.isEmpty else { return (matchup, waiverPool) }

        let players = allContexts.map(\.player)
        let gameList = Array(games)
        let weather = await researchProvider.weather(for: gameList)
        let news = await researchProvider.news(for: players, week: week)
        let betting = await researchProvider.bettingContext(for: gameList)

        guard !weather.isEmpty || !news.isEmpty || !betting.isEmpty else {
            return (matchup, waiverPool)
        }

        var newsByPlayer: [PlayerID: [NewsItem]] = [:]
        for item in news {
            for id in item.playerIDs {
                newsByPlayer[id, default: []].append(item)
            }
        }

        func apply(_ context: PlayerContext) -> PlayerContext {
            var updated = context
            if var environment = updated.environment {
                let home = environment.isHome
                    ? context.player.teamAbbreviation
                    : environment.opponentAbbreviation
                if environment.weather == nil, let conditions = weather[home] {
                    environment.weather = conditions
                }
                if environment.betting.overUnder == nil, let market = betting[home] {
                    environment.betting = market
                }
                updated.environment = environment
            }
            if let extra = newsByPlayer[context.id], !extra.isEmpty {
                let existing = Set(updated.news.map(\.id))
                updated.news += extra.filter { !existing.contains($0.id) }
            }
            return updated
        }

        var updatedMatchup = matchup
        updatedMatchup.userTeam.roster = matchup.userTeam.roster.map { entry in
            var updated = entry
            updated.context = apply(entry.context)
            return updated
        }
        if var opponent = matchup.opponentTeam {
            opponent.roster = opponent.roster.map { entry in
                var updated = entry
                updated.context = apply(entry.context)
                return updated
            }
            updatedMatchup.opponentTeam = opponent
        }

        return (updatedMatchup, waiverPool.map(apply))
    }

    // MARK: - Cache helpers

    private func cached<T: Codable & Sendable>(
        key: String,
        lifetime: TimeInterval,
        allowCache: Bool,
        load: () async throws -> T
    ) async throws -> T {
        if allowCache, let value = await cache.value(forKey: key, as: T.self) {
            return value
        }
        do {
            let value = try await load()
            await cache.store(value, forKey: key, lifetime: lifetime)
            return value
        } catch {
            // A stale answer beats an error screen when the network is flaky.
            if let stale = await cache.value(forKey: key, as: T.self) {
                AppLog.persistence.notice("Serving stale cache after load failure")
                return stale
            }
            throw error
        }
    }

    private func cachedOptional<T: Codable & Sendable>(
        key: String,
        lifetime: TimeInterval,
        allowCache: Bool,
        load: () async throws -> T
    ) async -> T? {
        try? await cached(key: key, lifetime: lifetime, allowCache: allowCache, load: load)
    }
}
