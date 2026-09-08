import Foundation

/// Reads ESPN's public NFL feeds — the ones that need no login.
///
/// These are separate from the fantasy league endpoints and require no cookies,
/// because none of it is private: the schedule, the injury report, the depth
/// chart and the betting line are the same for everyone.
///
/// The same caveat applies as everywhere else in this folder. ESPN publishes no
/// specification for any of it, so this is written defensively: every request can
/// fail without failing the week, every field can be absent, and every response
/// is recorded by `DiagnosticsLog` so a wrong assumption can be corrected from a
/// real payload rather than another guess.
struct ESPNPublicProvider: NFLContextProvider {
    let identifier = "espn-public"

    private let session: URLSession
    private let diagnostics: DiagnosticsLog
    /// The core API returns collections as lists of links, so reading one costs a
    /// request per item. This caps how many the app will follow in one go.
    private let maxFollowedLinks: Int

    init(
        session: URLSession = .shared,
        diagnostics: DiagnosticsLog = .shared,
        maxFollowedLinks: Int = 120
    ) {
        self.session = session
        self.diagnostics = diagnostics
        self.maxFollowedLinks = maxFollowedLinks
    }

    // MARK: - Schedule

    func games(season: Int, week: Int) async -> [NFLGame] {
        guard let url = ESPNPublicEndpoint.scoreboard(season: season, week: week) else { return [] }
        guard let board: ESPNPublicDTO.Scoreboard = await get(url, label: "Schedule week \(week)") else {
            return []
        }

        let games = (board.events ?? []).compactMap { event -> NFLGame? in
            guard let competition = event.competitions?.first else { return nil }
            let competitors = competition.competitors ?? []
            guard
                let home = competitors.first(where: { $0.isHome })?.team?.abbreviation,
                let away = competitors.first(where: { !$0.isHome })?.team?.abbreviation
            else { return nil }

            let homeTeam = NFLTeam.team(abbreviation: home)
            let market = bestOdds(from: competition.odds)

            return NFLGame(
                id: event.id?.value ?? "\(away)@\(home)",
                homeTeamAbbreviation: homeTeam.abbreviation,
                awayTeamAbbreviation: NFLTeam.team(abbreviation: away).abbreviation,
                kickoff: ESPNPublicDTO.date(from: competition.date ?? event.date),
                // Trust the venue when ESPN states it; fall back to the app's own
                // table, which is stable public knowledge either way.
                isIndoor: competition.venue?.indoor ?? homeTeam.isIndoor,
                overUnder: market?.overUnder,
                homeSpread: market?.homeSpread
            )
        }

        AppLog.network.debug("ESPN schedule week \(week, privacy: .public): \(games.count, privacy: .public) games")
        return games
    }

    /// Several sportsbooks can appear on one game; the lowest priority number is
    /// ESPN's preferred provider.
    private func bestOdds(
        from odds: [ESPNPublicDTO.Odds]?
    ) -> (overUnder: Double?, homeSpread: Double?)? {
        guard let odds, !odds.isEmpty else { return nil }
        let ranked = odds.sorted { ($0.provider?.priority ?? 99) < ($1.provider?.priority ?? 99) }
        for entry in ranked {
            let total = entry.overUnder?.value
            let spread = entry.spread?.value ?? spread(fromDetails: entry.details)
            if total != nil || spread != nil { return (total, spread) }
        }
        return nil
    }

    /// The `details` string looks like "KC -7.5". Used when the numeric spread
    /// field is absent.
    private func spread(fromDetails details: String?) -> Double? {
        guard let details else { return nil }
        let parts = details.split(separator: " ")
        guard let last = parts.last else { return nil }
        return Double(last.replacingOccurrences(of: "+", with: ""))
    }

    // MARK: - Injuries

    func injuryReports(season: Int) async -> [String: InjuryReport] {
        var reports: [String: InjuryReport] = [:]
        var budget = maxFollowedLinks

        for team in NFLTeam.all {
            guard budget > 0 else { break }
            guard let teamID = ESPNPublicEndpoint.teamID(for: team.abbreviation) else { continue }
            guard let url = ESPNPublicEndpoint.injuries(teamID: teamID) else { continue }
            guard let collection: ESPNPublicDTO.Collection<ESPNPublicDTO.RefOrValue<ESPNPublicDTO.Injury>> =
                await get(url, label: "Injuries \(team.abbreviation)") else { continue }

            for item in collection.items ?? [] {
                guard budget > 0 else { break }
                var injury = item.value
                // When the collection gave us only a link, follow it.
                if injury?.status == nil, let ref = item.ref, let refURL = URL(string: ref) {
                    budget -= 1
                    injury = await get(refURL, label: "Injury detail")
                }
                guard
                    let injury,
                    let athleteID = injury.athlete?.id?.value
                        ?? athleteID(fromRef: injury.athlete?.ref)
                else { continue }
                guard let report = report(from: injury) else { continue }
                reports[athleteID] = report
            }
        }

        AppLog.network.debug("ESPN injuries: \(reports.count, privacy: .public) players")
        return reports
    }

    private func report(from injury: ESPNPublicDTO.Injury) -> InjuryReport? {
        let comment = injury.longComment ?? injury.shortComment
        guard let status = ESPNPublicDTO.injuryStatus(from: injury.status)
            ?? ESPNPublicDTO.injuryStatus(from: injury.details?.fantasyStatus?.abbreviation)
        else { return nil }

        let designation = [injury.details?.side, injury.details?.location, injury.details?.detail]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
            .joined(separator: " ")

        return InjuryReport(
            status: status,
            designation: designation.isEmpty ? injury.type?.description : designation,
            practice: ESPNPublicDTO.practice(from: comment),
            note: comment,
            updatedAt: ESPNPublicDTO.date(from: injury.date)
        )
    }

    // MARK: - Depth charts

    func depthChart(season: Int) async -> [String: Int] {
        var ranks: [String: Int] = [:]

        for team in NFLTeam.all {
            guard let teamID = ESPNPublicEndpoint.teamID(for: team.abbreviation) else { continue }
            guard let url = ESPNPublicEndpoint.depthChart(season: season, teamID: teamID) else { continue }
            guard let chart: ESPNPublicDTO.DepthChart =
                await get(url, label: "Depth chart \(team.abbreviation)") else { continue }

            for group in chart.items ?? [] {
                for (_, position) in group.positions ?? [:] {
                    for entry in position.athletes ?? [] {
                        guard
                            let rank = entry.rank,
                            let athleteID = entry.athlete?.id?.value
                                ?? athleteID(fromRef: entry.athlete?.ref)
                        else { continue }
                        // A player can appear in more than one grouping; keep the
                        // best position they hold anywhere.
                        ranks[athleteID] = min(ranks[athleteID] ?? rank, rank)
                    }
                }
            }
        }

        AppLog.network.debug("ESPN depth charts: \(ranks.count, privacy: .public) players")
        return ranks
    }

    /// Core-API links end in the athlete's ID, sometimes with a query string.
    private func athleteID(fromRef ref: String?) -> String? {
        guard let ref, let url = URL(string: ref) else { return nil }
        let identifier = url.lastPathComponent
        return identifier.allSatisfy(\.isNumber) && !identifier.isEmpty ? identifier : nil
    }

    // MARK: - Fetching

    private func get<T: Decodable>(_ url: URL, label: String) async -> T? {
        var request = URLRequest(url: url)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 15

        do {
            let (data, response) = try await session.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode

            guard let status, (200...299).contains(status) else {
                await diagnostics.record(
                    label: label, url: url, statusCode: status, data: data, outcome: "http-error"
                )
                return nil
            }

            do {
                let decoded = try JSONDecoder().decode(T.self, from: data)
                await diagnostics.record(
                    label: label, url: url, statusCode: status, data: data, outcome: "ok"
                )
                return decoded
            } catch {
                // The most likely failure by far, and the one worth keeping the
                // body for: the payload arrived but is not shaped as expected.
                await diagnostics.record(
                    label: label, url: url, statusCode: status, data: data,
                    outcome: "decode-failed: \(error)"
                )
                AppLog.network.error("Failed to decode \(label, privacy: .public)")
                return nil
            }
        } catch {
            await diagnostics.record(
                label: label, url: url, statusCode: nil, data: nil,
                outcome: "network-error: \(error.localizedDescription)"
            )
            return nil
        }
    }
}
