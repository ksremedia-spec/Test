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
    var contextProvider: NFLContextProvider
    var narrator: NarrationProvider
    var cache: Cache
    var calendar: SeasonCalendar

    init(
        fantasyProvider: FantasyDataProvider,
        researchProvider: ResearchProvider = EmptyResearchProvider(),
        contextProvider: NFLContextProvider = EmptyNFLContextProvider(),
        narrator: NarrationProvider = TemplateNarrator(),
        cache: Cache,
        calendar: SeasonCalendar = SeasonCalendar()
    ) {
        self.fantasyProvider = fantasyProvider
        self.researchProvider = researchProvider
        self.contextProvider = contextProvider
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
        let enriched = await enrich(
            matchup: matchup,
            waiverPool: waiverPool,
            season: resolvedSeason,
            week: week,
            allowCache: allowCache
        )
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

    /// Fills in everything the fantasy provider could not supply: which game each
    /// player is in, the betting line, the weather, the depth chart, the injury
    /// report, and any news.
    ///
    /// Order matters. The schedule has to come first, because a player's opponent
    /// is what makes weather and matchup analysis possible at all — without it
    /// there is no stadium to look up conditions for and no defense to grade the
    /// matchup against.
    private func enrich(
        matchup: Matchup,
        waiverPool: [PlayerContext],
        season: Int,
        week: Int,
        allowCache: Bool
    ) async -> (matchup: Matchup, waiverPool: [PlayerContext]) {
        let allContexts = matchup.userTeam.roster.map(\.context)
            + (matchup.opponentTeam?.roster ?? []).map(\.context)
            + waiverPool
        guard !allContexts.isEmpty else { return (matchup, waiverPool) }

        // 1. The week's games. Cached for the day: an NFL schedule does not move.
        let loadedGames: [NFLGame]? = await cachedOptional(
            key: "schedule-\(season)-\(week)",
            lifetime: CacheLifetime.schedule,
            allowCache: allowCache
        ) {
            await contextProvider.games(season: season, week: week)
        }
        let games = loadedGames ?? []

        var gameByTeam: [String: NFLGame] = [:]
        for game in games {
            gameByTeam[game.homeTeamAbbreviation] = game
            gameByTeam[game.awayTeamAbbreviation] = game
        }

        // 2. Player status that is the same league-wide.
        let loadedDepthChart: [String: Int]? = await cachedOptional(
            key: "depthchart-\(season)-\(week)",
            lifetime: CacheLifetime.depthChart,
            allowCache: allowCache
        ) {
            await contextProvider.depthChart(season: season)
        }
        let depthChart = loadedDepthChart ?? [:]

        let loadedInjuries: [String: InjuryReport]? = await cachedOptional(
            key: "injuries-\(season)-\(week)",
            lifetime: CacheLifetime.injuries,
            allowCache: allowCache
        ) {
            await contextProvider.injuryReports(season: season)
        }
        let injuries = loadedInjuries ?? [:]

        // 3. Weather and news, both of which need the schedule to be useful.
        let scheduled = games.map { $0.scheduled(week: week) }
        let fallbackGames = scheduled.isEmpty ? existingGames(in: allContexts, week: week) : scheduled
        let weather = fallbackGames.isEmpty ? [:] : await researchProvider.weather(for: fallbackGames)
        let news = await researchProvider.news(for: allContexts.map(\.player), week: week)
        let marketFallback = fallbackGames.isEmpty ? [:] : await researchProvider.bettingContext(for: fallbackGames)

        let hasAnything = !gameByTeam.isEmpty || !depthChart.isEmpty || !injuries.isEmpty
            || !weather.isEmpty || !news.isEmpty || !marketFallback.isEmpty
        guard hasAnything else { return (matchup, waiverPool) }

        var newsByPlayer: [PlayerID: [NewsItem]] = [:]
        for item in news {
            for id in item.playerIDs {
                newsByPlayer[id, default: []].append(item)
            }
        }

        func apply(_ context: PlayerContext) -> PlayerContext {
            var updated = context
            let team = context.player.teamAbbreviation

            // The schedule builds an environment where none existed, and fills the
            // gaps in one that did.
            if let game = gameByTeam[team], let opponent = game.opponent(of: team) {
                var environment = updated.environment ?? GameEnvironment(
                    week: week,
                    opponentAbbreviation: opponent,
                    isHome: game.isHome(team)
                )
                environment.week = week
                environment.opponentAbbreviation = opponent
                environment.isHome = game.isHome(team)
                environment.isIndoor = game.isIndoor
                if environment.kickoff == nil { environment.kickoff = game.kickoff }
                if environment.betting.overUnder == nil {
                    environment.betting = game.bettingContext(for: team)
                }
                updated.environment = environment
            }

            if var environment = updated.environment {
                let home = environment.isHome ? team : environment.opponentAbbreviation
                if environment.weather == nil, let conditions = weather[home] {
                    environment.weather = conditions
                }
                if environment.betting.overUnder == nil, let market = marketFallback[home] {
                    environment.betting = market
                }
                updated.environment = environment
            }

            // Depth chart and injuries are keyed by the provider's player ID, so
            // they only join onto players from that same provider.
            let providerID = updated.player.id.value
            if updated.player.depthChartRank == nil, let rank = depthChart[providerID] {
                updated.player.depthChartRank = rank
            }
            // A richer injury report supersedes the bare designation the league
            // feed carries, but never overrides a player already ruled out.
            if let report = injuries[providerID], !updated.player.injury.status.isUnavailable {
                updated.player.injury = report
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

    /// Games implied by environments the fantasy provider already supplied. The
    /// demo league works this way, so it needs no schedule lookup.
    private func existingGames(in contexts: [PlayerContext], week: Int) -> [ScheduledGame] {
        let unique = Set(contexts.compactMap { context -> ScheduledGame? in
            guard let environment = context.environment else { return nil }
            let home = environment.isHome
                ? context.player.teamAbbreviation
                : environment.opponentAbbreviation
            let away = environment.isHome
                ? environment.opponentAbbreviation
                : context.player.teamAbbreviation
            return ScheduledGame(
                homeTeamAbbreviation: home,
                awayTeamAbbreviation: away,
                kickoff: environment.kickoff,
                week: week
            )
        })
        // Set iteration order is undefined, so sort for a stable request order.
        return unique.sorted { $0.id < $1.id }
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
