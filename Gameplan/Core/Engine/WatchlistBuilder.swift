import Foundation

/// Assembles the "what should I watch?" list.
///
/// The bar for inclusion is that the situation could still change the user's
/// decision. Things that are already settled belong in the moves list, not here,
/// and things that cannot change anything belong nowhere.
struct WatchlistBuilder {
    var league: League
    var week: Int
    var calendar: SeasonCalendar

    init(league: League, week: Int, calendar: SeasonCalendar = SeasonCalendar()) {
        self.league = league
        self.week = week
        self.calendar = calendar
    }

    func build(
        lineup: Lineup,
        players: [PlayerID: AnalyzedPlayer],
        bench: [AnalyzedPlayer],
        limit: Int = 5
    ) -> [WatchItem] {
        var items: [WatchItem] = []
        let starters = lineup.assignments.compactMap { $0.playerID.flatMap { players[$0] } }
        let kickoff = calendar.sundayKickoff()
        let kickoffDescription = kickoff.map { SeasonCalendar.deadlineDescription(for: $0) }

        // 1. Unresolved injuries in the starting lineup — the highest-value watch.
        for starter in starters where starter.player.injury.requiresMonitoring {
            let backup = bestReplacement(for: starter, from: bench, lineup: lineup, players: players)
            items.append(WatchItem(
                id: "watch-injury-\(starter.id.rawValue)",
                kind: .injury,
                title: "\(starter.player.fullName) — \(starter.player.injury.status.displayName.lowercased())",
                detail: injuryDetail(starter),
                contingency: backup.map {
                    "If he's ruled out, start \($0.player.fullName) in his place."
                } ?? "You have no clean replacement on the bench, so check waivers if he's ruled out.",
                playerID: starter.id,
                checkBy: kickoff,
                checkByDescription: kickoffDescription
            ))
        }

        // 2. Weather that materially changes a starter's outlook.
        for starter in starters {
            guard
                let environment = starter.context.environment,
                let weather = environment.effectiveWeather,
                weather.isNoteworthy
            else { continue }
            items.append(WatchItem(
                id: "watch-weather-\(starter.id.rawValue)",
                kind: .weather,
                title: "Conditions for \(starter.player.fullName) \(environment.opponentLabel)",
                detail: "\(weather.shortDescription). \(weatherEffect(for: starter.position))",
                contingency: nil,
                playerID: starter.id,
                checkBy: kickoff,
                checkByDescription: kickoffDescription
            ))
        }

        // 3. Bench players whose role is climbing — tomorrow's lineup decision.
        for player in bench where player.trend == .rising && player.projection.mean > 6 {
            items.append(WatchItem(
                id: "watch-usage-\(player.id.rawValue)",
                kind: .usage,
                title: "\(player.player.fullName)'s role is growing",
                detail: usageDetail(player),
                contingency: "If the trend holds another week, he moves ahead of your weakest starter.",
                playerID: player.id,
                checkBy: nil,
                checkByDescription: "After this week's games"
            ))
        }

        // 4. Significant news the engine has already reacted to, so the user can
        //    see why the plan changed.
        for player in starters + bench {
            for news in player.context.significantNews.prefix(1) where news.impact == .significant {
                items.append(WatchItem(
                    id: "watch-news-\(news.id)",
                    kind: .news,
                    title: news.headline,
                    detail: news.body ?? "\(player.player.fullName) — reported by \(news.sourceName).",
                    contingency: nil,
                    playerID: player.id,
                    checkBy: nil,
                    checkByDescription: nil
                ))
            }
        }

        // Deduplicate by player so one situation does not fill the whole list, and
        // keep the most decision-relevant kinds first.
        var seenPlayers = Set<PlayerID>()
        var result: [WatchItem] = []
        let ordered = items.sorted { lhs, rhs in
            rank(lhs.kind) == rank(rhs.kind) ? lhs.id < rhs.id : rank(lhs.kind) < rank(rhs.kind)
        }
        for item in ordered {
            if let playerID = item.playerID {
                guard !seenPlayers.contains(playerID) else { continue }
                seenPlayers.insert(playerID)
            }
            result.append(item)
            if result.count >= limit { break }
        }
        return result
    }

    private func rank(_ kind: WatchItem.Kind) -> Int {
        switch kind {
        case .injury: return 0
        case .gameTime: return 1
        case .weather: return 2
        case .depthChart: return 3
        case .usage: return 4
        case .news: return 5
        }
    }

    private func injuryDetail(_ player: AnalyzedPlayer) -> String {
        var parts: [String] = [player.player.injury.summary]
        let probability = player.player.injury.effectivePlayProbability
        parts.append("Gameplan is treating him as roughly \(Int((probability * 100).rounded()))% likely to play.")
        if let note = player.player.injury.note { parts.append(note) }
        return parts.joined(separator: " ")
    }

    private func weatherEffect(for position: Position) -> String {
        switch position {
        case .quarterback, .wideReceiver, .tightEnd:
            return "Wind and rain hurt passing volume most."
        case .runningBack:
            return "Bad weather usually means more carries, so this is mildly in his favor."
        case .kicker:
            return "Kickers are the most weather-sensitive players on any roster."
        case .defense:
            return "Sloppy conditions tend to help defenses."
        }
    }

    private func usageDetail(_ player: AnalyzedPlayer) -> String {
        let played = player.context.playedGames.sorted { $0.week < $1.week }
        let recent = Array(played.suffix(3))
        if let average = Statistics.mean(recent.map(\.fantasyPoints)) {
            return String(
                format: "%.1f points per game over his last %d, and his snap share is climbing.",
                average, recent.count
            )
        }
        return "His workload has been increasing."
    }

    /// Best legal stand-in from the bench if a starter is ruled out.
    private func bestReplacement(
        for starter: AnalyzedPlayer,
        from bench: [AnalyzedPlayer],
        lineup: Lineup,
        players: [PlayerID: AnalyzedPlayer]
    ) -> AnalyzedPlayer? {
        guard let slot = lineup.slot(for: starter.id) else { return nil }
        return bench
            .filter { slot.accepts($0.position) && !$0.player.isUnavailable(week: week) }
            .max { $0.projection.mean < $1.projection.mean }
    }
}
