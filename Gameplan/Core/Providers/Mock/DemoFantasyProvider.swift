import Foundation

/// Serves the fictional demo league.
///
/// It exists for three reasons: the app must be fully usable before anyone
/// connects a real league, every screen needs a realistic state to be designed
/// against, and the engine needs a fixture that does not depend on the network.
/// `isDemo` is true so the UI can label it everywhere it appears.
struct DemoFantasyProvider: FantasyDataProvider {
    let identifier = DemoLeague.source
    let isDemo = true

    private let now: Date

    init(now: Date = Date()) {
        self.now = now
    }

    func availableLeagues() async throws -> [LeagueSummary] {
        let league = DemoLeague.league(now: now)
        return [
            LeagueSummary(
                id: league.id,
                name: league.name,
                season: league.season,
                teamCount: league.teamCount,
                userTeamID: DemoLeague.userTeamID,
                userTeamName: "Third & Long"
            )
        ]
    }

    func league(id: String, season: Int) async throws -> League {
        guard id == DemoLeague.leagueID else { throw FantasyDataError.leagueNotFound(id) }
        var league = DemoLeague.league(now: now)
        league.season = season
        return league
    }

    func currentWeek(leagueID: String, season: Int) async throws -> Int {
        DemoLeague.currentWeek(now: now)
    }

    func teams(leagueID: String, season: Int) async throws -> [TeamSummary] {
        [
            TeamSummary(id: DemoLeague.userTeamID, name: "Third & Long", ownerName: "You", recordLabel: "4-2"),
            TeamSummary(id: "demo-team-2", name: "Gridiron Ghosts", ownerName: "Priya", recordLabel: "5-1")
        ]
    }

    func matchup(leagueID: String, season: Int, week: Int, teamID: String) async throws -> Matchup {
        guard leagueID == DemoLeague.leagueID else { throw FantasyDataError.leagueNotFound(leagueID) }

        let userTeam = FantasyTeam(
            id: DemoLeague.userTeamID,
            name: "Third & Long",
            ownerName: "You",
            abbreviation: "T&L",
            wins: 4,
            losses: 2,
            pointsFor: 742.6,
            pointsAgainst: 698.1,
            standing: 4,
            roster: DemoLeague.userTeamSpecs.enumerated().map { index, spec in
                RosterEntry(
                    context: context(for: spec, week: week, seedOffset: index),
                    slot: spec.slot,
                    acquisition: index < 9 ? .draft : .waiver
                )
            },
            faabRemaining: 63,
            waiverPriority: 7
        )

        let opponentTeam = FantasyTeam(
            id: "demo-team-2",
            name: "Gridiron Ghosts",
            ownerName: "Priya",
            abbreviation: "GHST",
            wins: 5,
            losses: 1,
            pointsFor: 801.4,
            pointsAgainst: 704.9,
            standing: 2,
            roster: DemoLeague.opponentSpecs.enumerated().map { index, spec in
                RosterEntry(
                    context: context(for: spec, week: week, seedOffset: 100 + index),
                    slot: spec.slot,
                    acquisition: .draft
                )
            },
            faabRemaining: 22,
            waiverPriority: 11
        )

        return Matchup(
            id: "demo-\(week)",
            week: week,
            userTeam: userTeam,
            opponentTeam: opponentTeam,
            isComplete: false,
            lineupLockDate: SeasonCalendar(now: now).sundayKickoff()
        )
    }

    func freeAgents(leagueID: String, season: Int, week: Int, limit: Int) async throws -> [PlayerContext] {
        DemoLeague.waiverSpecs
            .enumerated()
            .map { index, spec in context(for: spec, week: week, seedOffset: 200 + index) }
            .prefix(limit)
            .map { $0 }
    }

    func recentTransactions(leagueID: String, season: Int) async throws -> [Transaction] { [] }

    // MARK: - Building contexts

    private func context(for spec: DemoLeague.Spec, week: Int, seedOffset: Int) -> PlayerContext {
        let parts = spec.name.split(separator: " ", maxSplits: 1)
        let first = parts.count > 1 ? String(parts[0]) : ""
        let last = parts.count > 1 ? String(parts[1]) : spec.name

        let player = Player(
            id: PlayerID(source: DemoLeague.source, value: slug(spec.name)),
            firstName: first,
            lastName: last,
            position: spec.position,
            teamAbbreviation: spec.team,
            jerseyNumber: nil,
            byeWeek: spec.byeWeek,
            injury: spec.injury,
            depthChartRank: spec.depthRank,
            rosteredPercentage: spec.rostered,
            rosteredPercentageChange: spec.rosteredChange
        )

        let seasonUsage = usage(from: spec, games: max(1, week - 1), pointsPerGame: spec.pointsPerGame,
                               snapShare: spec.snapShare)
        let recentUsage = usage(
            from: spec,
            games: min(3, max(1, week - 1)),
            pointsPerGame: spec.recentPointsPerGame ?? spec.pointsPerGame,
            snapShare: spec.recentSnapShare ?? spec.snapShare
        )

        let homeTeam = spec.isHome ? spec.team : spec.opponent
        let environment = GameEnvironment(
            week: week,
            kickoff: SeasonCalendar(now: now).sundayKickoff(),
            opponentAbbreviation: spec.opponent,
            isHome: spec.isHome,
            isIndoor: NFLTeam.team(abbreviation: homeTeam).isIndoor,
            weather: demoWeather(homeTeam: homeTeam),
            betting: BettingContext(),
            defensiveMatchup: spec.defenseRankAgainstPosition.map {
                DefensiveMatchup(opponentAbbreviation: spec.opponent, rankAgainstPosition: $0)
            },
            teamPlaysPerGame: nil,
            teamPassRate: nil
        )

        return PlayerContext(
            player: player,
            recentUsage: recentUsage,
            seasonUsage: seasonUsage,
            gameLog: gameLog(for: spec, week: week, seed: UInt64(seedOffset + 1)),
            environment: environment,
            providerProjectedPoints: spec.projection,
            news: demoNews(for: spec, player: player)
        )
    }

    private func usage(
        from spec: DemoLeague.Spec,
        games: Int,
        pointsPerGame: Double,
        snapShare: Double?
    ) -> PlayerUsage {
        let touches: Double? = {
            switch (spec.carries, spec.targets) {
            case (let carries?, let targets?): return carries + targets
            case (let carries?, nil): return carries
            case (nil, let targets?): return targets
            default: return nil
            }
        }()

        return PlayerUsage(
            games: games,
            snapShare: snapShare,
            routeParticipation: spec.routeParticipation,
            targetShare: spec.targetShare,
            targetsPerGame: spec.targets,
            carriesPerGame: spec.carries,
            receptionsPerGame: spec.targets.map { $0 * 0.66 },
            touchesPerGame: touches,
            redZoneTouchesPerGame: spec.redZone,
            goalLineCarriesPerGame: spec.redZone.map { $0 * 0.4 },
            airYardsPerGame: spec.airYards,
            averageDepthOfTarget: spec.airYards.flatMap { airYards in
                spec.targets.map { airYards / max(1, $0) }
            },
            fantasyPointsPerGame: pointsPerGame,
            fantasyPointsPerTouch: touches.map { pointsPerGame / max(1, $0) }
        )
    }

    /// Deterministic weekly scores around the player's average, so trend lines and
    /// observed variance in the demo behave like real ones.
    private func gameLog(for spec: DemoLeague.Spec, week: Int, seed: UInt64) -> [GameLogEntry] {
        guard week > 1 else { return [] }
        var generator = SeededGenerator(seed: seed &* 7919)
        let deviation = max(1.5, spec.pointsPerGame * spec.position.baselineVariation)
        let recentAverage = spec.recentPointsPerGame ?? spec.pointsPerGame
        let playedWeeks = (1..<week).filter { $0 != spec.byeWeek }

        return playedWeeks.map { playedWeek in
            let isRecent = playedWeek >= week - 3
            let base = isRecent ? recentAverage : spec.pointsPerGame
            let value = max(0, base + generator.nextGaussian() * deviation * 0.80)
            let snapBase = (isRecent ? spec.recentSnapShare : spec.snapShare) ?? spec.snapShare
            return GameLogEntry(
                week: playedWeek,
                opponentAbbreviation: spec.opponent,
                wasHome: playedWeek.isMultiple(of: 2),
                fantasyPoints: (value * 10).rounded() / 10,
                snapShare: snapBase.map { min(1, max(0, $0 + generator.nextDouble(in: -0.05...0.05))) },
                targets: spec.targets.map { Int(($0 + generator.nextDouble(in: -2...2)).rounded()) },
                carries: spec.carries.map { Int(($0 + generator.nextDouble(in: -3...3)).rounded()) },
                receptions: spec.targets.map { Int((($0 * 0.66) + generator.nextDouble(in: -1...1)).rounded()) },
                didNotPlay: false
            )
        }
    }

    /// A small number of fictional news items, attached only where they explain
    /// something the engine is already reacting to.
    private func demoNews(for spec: DemoLeague.Spec, player: Player) -> [NewsItem] {
        switch spec.name {
        case "Deon Ridley":
            return [NewsItem(
                id: "demo-news-ridley",
                headline: "Ridley moves into the starting lineup",
                body: "With the team's WR1 sidelined, Ridley took 88% of snaps and drew eight targets in his first start.",
                publishedAt: now.addingTimeInterval(-36 * 3600),
                sourceName: "Demo Wire",
                playerIDs: [player.id],
                impact: .significant
            )]
        case "Cade Whitfield":
            return [NewsItem(
                id: "demo-news-whitfield",
                headline: "Whitfield limited again with ankle injury",
                body: "Coaches called him day-to-day and said a decision is unlikely before Sunday morning.",
                publishedAt: now.addingTimeInterval(-14 * 3600),
                sourceName: "Demo Wire",
                playerIDs: [player.id],
                impact: .significant
            )]
        case "Marquis Feld":
            return [NewsItem(
                id: "demo-news-feld",
                headline: "Feld takes over lead back duties",
                body: "Feld handled 13 carries and all four goal-line looks after the starter left in the first quarter.",
                publishedAt: now.addingTimeInterval(-48 * 3600),
                sourceName: "Demo Wire",
                playerIDs: [player.id],
                impact: .significant
            )]
        case "Jonah Whitaker":
            return [NewsItem(
                id: "demo-news-whitaker",
                headline: "Whitaker's route share climbs for a third straight week",
                body: "He has run a route on 88% of dropbacks over the last three games, up from 71% earlier in the season.",
                publishedAt: now.addingTimeInterval(-60 * 3600),
                sourceName: "Demo Wire",
                playerIDs: [player.id],
                impact: .notable
            )]
        case "Trip Halloran":
            return [NewsItem(
                id: "demo-news-halloran",
                headline: "Halloran's snaps dip as the offense leans on two-tight-end sets",
                publishedAt: now.addingTimeInterval(-70 * 3600),
                sourceName: "Demo Wire",
                playerIDs: [player.id],
                impact: .notable
            )]
        default:
            return []
        }
    }

    /// One deliberately windy outdoor game so the weather path is exercised.
    private func demoWeather(homeTeam: String) -> WeatherConditions? {
        guard !NFLTeam.team(abbreviation: homeTeam).isIndoor else { return nil }
        switch homeTeam {
        case "BAL":
            return WeatherConditions(
                temperatureFahrenheit: 38,
                windMilesPerHour: 22,
                precipitationChance: 0.35,
                summary: "Windy"
            )
        case "GB":
            return WeatherConditions(
                temperatureFahrenheit: 34,
                windMilesPerHour: 11,
                precipitationChance: 0.55,
                summary: "Cold and wet"
            )
        default:
            return WeatherConditions(
                temperatureFahrenheit: 58,
                windMilesPerHour: 6,
                precipitationChance: 0.05,
                summary: "Clear"
            )
        }
    }

    private func slug(_ name: String) -> String {
        name.lowercased()
            .replacingOccurrences(of: " ", with: "-")
            .filter { $0.isLetter || $0 == "-" }
    }
}
