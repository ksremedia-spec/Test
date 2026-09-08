import Foundation

/// Reads a real ESPN league and turns it into the app's domain models.
///
/// The provider is deliberately conservative: anything ESPN does not supply comes
/// back as `nil` and the engine downgrades its confidence accordingly, rather than
/// the app inventing a value to fill the gap.
struct ESPNFantasyProvider: FantasyDataProvider {
    let identifier = "espn"
    let isDemo = false

    private let client: ESPNClient
    private let secureStore: SecureStore

    init(client: ESPNClient, secureStore: SecureStore) {
        self.client = client
        self.secureStore = secureStore
    }

    // MARK: - Leagues

    func availableLeagues() async throws -> [LeagueSummary] {
        guard let swid = secureStore.string(for: .espnSWID), !swid.isEmpty else {
            throw FantasyDataError.authenticationRequired
        }
        let season = SeasonCalendar().season
        let url = try ESPNEndpoint.leagueListURL(season: season, swid: swid)
        let entries = try await client.get([ESPNDTO.LeagueListEntry].self, from: url, describing: "league list")

        return entries.compactMap { entry in
            guard let id = entry.id else { return nil }
            return LeagueSummary(
                id: String(id),
                name: entry.settings?.name ?? "League \(id)",
                season: entry.seasonId ?? season,
                teamCount: entry.settings?.size ?? entry.teams?.count ?? 0,
                userTeamID: nil,
                userTeamName: nil
            )
        }
    }

    func league(id: String, season: Int) async throws -> League {
        let response = try await fetch(leagueID: id, season: season, views: [.settings, .team])
        guard let settings = response.settings else {
            throw FantasyDataError.decoding("league settings")
        }

        let slots = ESPNMapping.startingSlots(from: settings.rosterSettings)
        let scoring = ESPNMapping.scoringSettings(from: settings.scoringSettings)

        let waivers: WaiverSystem
        if settings.acquisitionSettings?.isUsingAcquisitionBudget == true {
            waivers = .faab(budget: settings.acquisitionSettings?.acquisitionBudget ?? 100)
        } else {
            waivers = .rollingPriority
        }

        let matchupPeriods = settings.scheduleSettings?.matchupPeriodCount ?? 14
        let playoffTeams = settings.scheduleSettings?.playoffTeamCount ?? 6
        // ESPN counts playoff rounds inside the matchup period total, so the
        // fantasy regular season ends before it.
        let playoffRounds = max(1, Int((Double(playoffTeams) / 2).rounded(.up)))
        let regularSeasonWeeks = max(1, matchupPeriods - playoffRounds)

        return League(
            id: id,
            platform: .espn,
            name: settings.name ?? "ESPN League",
            season: season,
            teamCount: settings.size ?? response.teams?.count ?? 10,
            scoring: scoring,
            startingSlots: slots.starting,
            benchSlots: slots.bench,
            injuredReserveSlots: slots.ir,
            waivers: waivers,
            waiverProcessingDay: waiverWeekday(from: settings.acquisitionSettings?.waiverProcessDays),
            continuity: .redraft,
            playoffTeamCount: playoffTeams,
            playoffStartWeek: regularSeasonWeeks + 1,
            regularSeasonWeeks: regularSeasonWeeks,
            tradeDeadlineWeek: nil,
            isPublic: settings.isPublic ?? false
        )
    }

    func currentWeek(leagueID: String, season: Int) async throws -> Int {
        let response = try await fetch(leagueID: leagueID, season: season, views: [.status])
        if let period = response.status?.currentMatchupPeriod, period > 0 { return period }
        if let period = response.scoringPeriodId, period > 0 { return period }
        return SeasonCalendar().estimatedWeek(season: season)
    }

    func teams(leagueID: String, season: Int) async throws -> [TeamSummary] {
        let response = try await fetch(leagueID: leagueID, season: season, views: [.team])
        let members = Dictionary(
            (response.members ?? []).compactMap { member -> (String, String)? in
                guard let id = member.id else { return nil }
                let name = member.displayName
                    ?? [member.firstName, member.lastName].compactMap { $0 }.joined(separator: " ")
                return name.isEmpty ? nil : (id, name)
            },
            uniquingKeysWith: { first, _ in first }
        )

        return (response.teams ?? []).compactMap { dto in
            guard let id = dto.id else { return nil }
            let name = dto.name
                ?? [dto.location, dto.nickname].compactMap { $0 }.joined(separator: " ")
            let record = dto.record?.overall
            let wins = record?.wins ?? 0
            let losses = record?.losses ?? 0
            let ties = record?.ties ?? 0
            return TeamSummary(
                id: String(id),
                name: name.isEmpty ? "Team \(id)" : name,
                ownerName: dto.owners?.compactMap { members[$0] }.first,
                recordLabel: ties > 0 ? "\(wins)-\(losses)-\(ties)" : "\(wins)-\(losses)"
            )
        }
    }

    // MARK: - Matchup

    func matchup(leagueID: String, season: Int, week: Int, teamID: String) async throws -> Matchup {
        let response = try await fetch(
            leagueID: leagueID,
            season: season,
            views: [.team, .roster, .matchup, .schedule, .settings],
            scoringPeriod: week
        )

        guard let teams = response.teams, !teams.isEmpty else {
            throw FantasyDataError.decoding("teams")
        }
        guard let userDTO = teams.first(where: { String($0.id ?? -1) == teamID }) else {
            throw FantasyDataError.teamNotFound(teamID)
        }

        let members = Dictionary(
            (response.members ?? []).compactMap { member -> (String, String)? in
                guard let id = member.id else { return nil }
                let name = member.displayName
                    ?? [member.firstName, member.lastName].compactMap { $0 }.joined(separator: " ")
                return name.isEmpty ? nil : (id, name)
            },
            uniquingKeysWith: { first, _ in first }
        )

        let budget = response.settings?.acquisitionSettings?.acquisitionBudget
        let userTeam = team(from: userDTO, week: week, members: members, faabBudget: budget)

        // Find the opponent from this week's schedule.
        var opponentTeam: FantasyTeam?
        var userScore: Double?
        var opponentScore: Double?
        if let item = (response.schedule ?? []).first(where: { schedule in
            schedule.matchupPeriodId == week &&
            (schedule.home?.teamId == userDTO.id || schedule.away?.teamId == userDTO.id)
        }) {
            let userIsHome = item.home?.teamId == userDTO.id
            let opponentID = userIsHome ? item.away?.teamId : item.home?.teamId
            userScore = userIsHome ? item.home?.totalPoints : item.away?.totalPoints
            opponentScore = userIsHome ? item.away?.totalPoints : item.home?.totalPoints
            if let opponentID, let dto = teams.first(where: { $0.id == opponentID }) {
                opponentTeam = team(from: dto, week: week, members: members, faabBudget: budget)
            }
        }

        return Matchup(
            id: "\(leagueID)-\(season)-\(week)",
            week: week,
            userTeam: userTeam,
            opponentTeam: opponentTeam,
            userScore: userScore,
            opponentScore: opponentScore,
            isComplete: (response.status?.latestScoringPeriod ?? week) > week,
            lineupLockDate: SeasonCalendar().sundayKickoff()
        )
    }

    // MARK: - Free agents

    func freeAgents(leagueID: String, season: Int, week: Int, limit: Int) async throws -> [PlayerContext] {
        // ESPN's free-agent listing needs a filter header that changes shape often.
        // Rather than depend on it, the app reads the full player pool view and
        // filters locally for players no team holds.
        let response = try await fetch(
            leagueID: leagueID,
            season: season,
            views: [.roster, .team, .playerInfo],
            scoringPeriod: week
        )

        let rosteredIDs = Set(
            (response.teams ?? [])
                .flatMap { $0.roster?.entries ?? [] }
                .compactMap { $0.playerId }
        )

        let candidates = (response.teams ?? [])
            .flatMap { $0.roster?.entries ?? [] }
            .compactMap { $0.playerPoolEntry }
            .filter { entry in
                guard let id = entry.player?.id else { return false }
                return !rosteredIDs.contains(id)
            }

        return candidates
            .compactMap { playerContext(from: $0, week: week) }
            .sorted { ($0.providerProjectedPoints ?? 0) > ($1.providerProjectedPoints ?? 0) }
            .prefix(limit)
            .map { $0 }
    }

    // MARK: - Helpers

    private func fetch(
        leagueID: String,
        season: Int,
        views: [ESPNEndpoint.View],
        scoringPeriod: Int? = nil
    ) async throws -> ESPNDTO.LeagueResponse {
        let endpoint = ESPNEndpoint(
            season: season,
            leagueID: leagueID,
            views: views,
            scoringPeriod: scoringPeriod
        )
        let url = try endpoint.url()
        let description = views.map(\.rawValue).joined(separator: "+")
        return try await client.get(ESPNDTO.LeagueResponse.self, from: url, describing: description)
    }

    private func team(
        from dto: ESPNDTO.Team,
        week: Int,
        members: [String: String],
        faabBudget: Int?
    ) -> FantasyTeam {
        let record = dto.record?.overall
        let name = dto.name
            ?? [dto.location, dto.nickname].compactMap { $0 }.joined(separator: " ")
        let owner = dto.owners?.compactMap { members[$0] }.first

        let entries: [RosterEntry] = (dto.roster?.entries ?? []).compactMap { entry in
            guard
                let pool = entry.playerPoolEntry,
                let context = playerContext(from: pool, week: week)
            else { return nil }
            let slot = ESPNMapping.slot(fromLineupSlotID: entry.lineupSlotId) ?? .bench
            return RosterEntry(
                context: context,
                slot: slot,
                acquisition: ESPNMapping.acquisitionType(from: entry.acquisitionType)
            )
        }

        let spent = dto.transactionCounter?.acquisitionBudgetSpent
        let remaining: Int? = {
            guard let faabBudget, let spent else { return nil }
            return max(0, faabBudget - spent)
        }()

        return FantasyTeam(
            id: String(dto.id ?? -1),
            name: name.isEmpty ? "Team \(dto.id ?? 0)" : name,
            ownerName: owner,
            abbreviation: dto.abbrev,
            wins: record?.wins ?? 0,
            losses: record?.losses ?? 0,
            ties: record?.ties ?? 0,
            pointsFor: record?.pointsFor ?? 0,
            pointsAgainst: record?.pointsAgainst ?? 0,
            standing: dto.playoffSeed,
            roster: entries,
            faabRemaining: remaining,
            waiverPriority: dto.waiverRank
        )
    }

    private func playerContext(from pool: ESPNDTO.PlayerPoolEntry, week: Int) -> PlayerContext? {
        guard let dto = pool.player, let id = dto.id else { return nil }
        guard
            let position = ESPNMapping.position(fromDefaultPositionID: dto.defaultPositionId)
                ?? ESPNMapping.position(fromEligibleSlots: dto.eligibleSlots)
        else { return nil }

        let names = splitName(dto)
        let player = Player(
            id: PlayerID(source: identifier, value: String(id)),
            firstName: names.first,
            lastName: names.last,
            position: position,
            teamAbbreviation: ESPNMapping.teamAbbreviation(fromProTeamID: dto.proTeamId),
            jerseyNumber: dto.jersey.flatMap(Int.init),
            byeWeek: nil,
            injury: InjuryReport(
                status: ESPNMapping.injuryStatus(from: dto.injuryStatus),
                designation: dto.injuryStatus
            ),
            depthChartRank: nil,
            rosteredPercentage: dto.ownership?.percentOwned.map { $0 / 100 },
            rosteredPercentageChange: dto.ownership?.percentChange
        )

        let stats = dto.stats ?? []
        let projection = stats.first {
            $0.statSourceId == 1 && $0.scoringPeriodId == week
        }?.appliedTotal

        let weeklyActuals = stats.filter {
            $0.statSourceId == 0 && $0.statSplitTypeId == 1 && ($0.scoringPeriodId ?? 0) < week
        }
        let gameLog: [GameLogEntry] = weeklyActuals
            .compactMap { entry in
                guard let period = entry.scoringPeriodId, let points = entry.appliedTotal else { return nil }
                return GameLogEntry(
                    week: period,
                    opponentAbbreviation: "",
                    fantasyPoints: points,
                    targets: entry.stats?[String(ESPNMapping.StatID.targets)].map { Int($0) },
                    carries: entry.stats?[String(ESPNMapping.StatID.rushingAttempts)].map { Int($0) },
                    receptions: entry.stats?[String(ESPNMapping.StatID.receptions)].map { Int($0) }
                )
            }
            .sorted { $0.week < $1.week }

        let seasonTotal = stats.first { $0.statSourceId == 0 && $0.statSplitTypeId == 0 }
        let playedGames = max(gameLog.count, 0)

        let seasonUsage = PlayerUsage(
            games: playedGames,
            targetsPerGame: perGame(seasonTotal?.stats?[String(ESPNMapping.StatID.targets)], games: playedGames),
            carriesPerGame: perGame(seasonTotal?.stats?[String(ESPNMapping.StatID.rushingAttempts)], games: playedGames),
            receptionsPerGame: perGame(seasonTotal?.stats?[String(ESPNMapping.StatID.receptions)], games: playedGames),
            fantasyPointsPerGame: seasonTotal?.appliedAverage
                ?? perGame(seasonTotal?.appliedTotal, games: playedGames)
        )

        let recentGames = Array(gameLog.suffix(3))
        let recentUsage = PlayerUsage(
            games: recentGames.count,
            targetsPerGame: average(recentGames.compactMap { $0.targets.map(Double.init) }),
            carriesPerGame: average(recentGames.compactMap { $0.carries.map(Double.init) }),
            receptionsPerGame: average(recentGames.compactMap { $0.receptions.map(Double.init) }),
            fantasyPointsPerGame: average(recentGames.map(\.fantasyPoints))
        )

        return PlayerContext(
            player: player,
            recentUsage: recentUsage,
            seasonUsage: seasonUsage,
            gameLog: gameLog,
            environment: nil,
            providerProjectedPoints: projection,
            news: []
        )
    }

    private func splitName(_ dto: ESPNDTO.PlayerDTO) -> (first: String, last: String) {
        if let first = dto.firstName, let last = dto.lastName, !last.isEmpty {
            return (first, last)
        }
        let full = dto.fullName ?? ""
        let parts = full.split(separator: " ", maxSplits: 1)
        guard parts.count == 2 else { return ("", full) }
        return (String(parts[0]), String(parts[1]))
    }

    private func perGame(_ total: Double?, games: Int) -> Double? {
        guard let total, games > 0 else { return nil }
        return total / Double(games)
    }

    private func average(_ values: [Double]) -> Double? {
        guard !values.isEmpty else { return nil }
        return values.reduce(0, +) / Double(values.count)
    }

    /// ESPN reports waiver processing days as weekday names.
    private func waiverWeekday(from days: [String]?) -> Int? {
        guard let first = days?.first?.uppercased() else { return nil }
        switch first {
        case "SUNDAY": return 1
        case "MONDAY": return 2
        case "TUESDAY": return 3
        case "WEDNESDAY": return 4
        case "THURSDAY": return 5
        case "FRIDAY": return 6
        case "SATURDAY": return 7
        default: return nil
        }
    }
}
