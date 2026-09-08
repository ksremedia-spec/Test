import Foundation

/// The complete result of analysing one week.
struct WeeklyAnalysis: Sendable {
    var plan: GamePlan
    var userPlayers: [PlayerID: AnalyzedPlayer]
    var opponentPlayers: [PlayerID: AnalyzedPlayer]
    var waiverCandidates: [WaiverCandidate]
    var currentLineup: Lineup
    var optimalLineup: Lineup
    var opponentLineup: Lineup?
    var evidence: EvidencePack

    func player(for id: PlayerID) -> AnalyzedPlayer? {
        userPlayers[id] ?? opponentPlayers[id] ?? waiverCandidates.first { $0.id == id }?.player
    }
}

/// Stages the analysis reports as it runs, so the loading screen can say
/// something true instead of spinning.
enum AnalysisStage: String, Sendable, CaseIterable {
    case readingRoster
    case projecting
    case simulating
    case findingMoves
    case scanningWaivers
    case writing

    var message: String {
        switch self {
        case .readingRoster: return "Reading your roster"
        case .projecting: return "Projecting every player"
        case .simulating: return "Comparing lineups against your opponent"
        case .findingMoves: return "Finding the moves that matter"
        case .scanningWaivers: return "Scanning the waiver wire"
        case .writing: return "Writing your game plan"
        }
    }
}

/// Runs the whole analysis: project, optimise, compare, rank, explain.
///
/// The order matters. Projections come first because everything downstream reads
/// them; the opponent is projected before the user's lineup is optimised because
/// the optimiser's objective depends on what it is trying to beat; and prose is
/// written last, from results that are already fixed.
struct GamePlanBuilder {
    var league: League
    var week: Int
    var narrator: NarrationProvider
    var calendar: SeasonCalendar

    init(
        league: League,
        week: Int,
        narrator: NarrationProvider = TemplateNarrator(),
        calendar: SeasonCalendar = SeasonCalendar()
    ) {
        self.league = league
        self.week = week
        self.narrator = narrator
        self.calendar = calendar
    }

    func build(
        matchup: Matchup,
        waiverPool: [PlayerContext],
        onStage: ((AnalysisStage) -> Void)? = nil
    ) async -> WeeklyAnalysis {
        onStage?(.readingRoster)

        let projectionEngine = PlayerProjectionEngine(league: league, week: week)

        onStage?(.projecting)
        let userPlayers = index(matchup.userTeam.roster.map { projectionEngine.analyze($0.context) })
        let opponentPlayers = index((matchup.opponentTeam?.roster ?? []).map { projectionEngine.analyze($0.context) })
        let waiverPlayers = waiverPool.map { projectionEngine.analyze($0) }

        onStage?(.simulating)
        let matchupAnalyzer = MatchupAnalyzer(league: league, week: week)
        var opponentSummary: (mean: Double, deviation: Double)?
        var opponentLineup: Lineup?
        if let opponentTeam = matchup.opponentTeam {
            let result = matchupAnalyzer.opponentProjection(team: opponentTeam, players: opponentPlayers)
            opponentSummary = (result.mean, result.deviation)
            opponentLineup = result.lineup
        }

        let optimizer = LineupOptimizer(league: league, opponent: opponentSummary)
        let currentLineup = optimizer.currentLineup(for: matchup.userTeam, players: userPlayers)
        let candidates = matchup.userTeam.availableForLineup.compactMap { userPlayers[$0.id] }
        let optimalLineup = optimizer.optimize(candidates: candidates, players: userPlayers)

        // The outlook describes the position the user is in *right now*, with the
        // lineup they currently have set. Everything the optimal lineup would add
        // is expressed through the moves and their win-probability deltas, so the
        // number on screen and the numbers in the advice always agree.
        let outlook = matchupAnalyzer.outlook(
            userLineup: currentLineup,
            opponent: opponentSummary,
            userPlayers: userPlayers,
            opponentLineup: opponentLineup,
            opponentPlayers: opponentPlayers
        )
        let currentWinProbability = outlook.winProbability

        onStage?(.findingMoves)
        let rosterAnalyzer = RosterAnalyzer(league: league)
        let replacementLevels = rosterAnalyzer.replacementLevels(waiverPool: waiverPlayers)
        let assessments = rosterAnalyzer.assess(
            team: matchup.userTeam,
            players: userPlayers,
            replacementLevels: replacementLevels,
            week: week
        )
        let weakness = rosterAnalyzer.biggestWeakness(from: assessments)

        // Posture is judged from where the user stands *before* making changes,
        // because that is the situation the advice has to work in.
        let posture = WeeklyPosture.from(winProbability: currentWinProbability)
        let lineupDeadline = matchup.lineupLockDate ?? calendar.sundayKickoff()

        let startSit = StartSitAnalyzer(
            league: league,
            week: week,
            optimizer: optimizer,
            posture: posture,
            deadline: lineupDeadline
        )
        var moves = startSit.recommendations(
            current: currentLineup,
            optimal: optimalLineup,
            players: userPlayers
        )

        onStage?(.scanningWaivers)
        let waiverDeadline = calendar.nextWaiverProcessing(weekday: league.waiverProcessingDay)
        let waiverAnalyzer = WaiverAnalyzer(
            league: league,
            week: week,
            replacementLevels: replacementLevels,
            assessments: assessments,
            faabRemaining: matchup.userTeam.faabRemaining,
            deadline: waiverDeadline
        )
        let waiverCandidates = waiverAnalyzer.rank(
            pool: waiverPlayers,
            roster: candidates,
            currentLineup: currentLineup,
            optimizer: optimizer,
            players: userPlayers
        )
        moves += waiverCandidates.enumerated().map { index, candidate in
            waiverAnalyzer.recommendation(for: candidate, rank: index)
        }

        let tradeAnalyzer = TradeAnalyzer(league: league, week: week, replacementLevels: replacementLevels)
        moves += tradeAnalyzer.recommendations(
            assessments: assessments,
            roster: candidates,
            currentLineup: currentLineup
        )

        let bench = candidates.filter { !currentLineup.startingPlayerIDs.contains($0.id) }
        let watchItems = WatchlistBuilder(league: league, week: week, calendar: calendar).build(
            lineup: currentLineup,
            players: userPlayers,
            bench: bench
        )

        // When there is nothing to change about the lineup, say so explicitly.
        // Silence would leave the user unable to tell "checked, all good" from
        // "didn't look". The cap is reduced by one to make room for it, so the
        // list length is the same either way.
        let hasLineupAdvice = moves.contains { $0.category == .lineup }
        moves = prioritize(moves, limit: hasLineupAdvice ? 6 : 5)
        if !hasLineupAdvice {
            moves.append(startSit.confirmationRecommendation(current: currentLineup, players: userPlayers))
        }

        let dataQuality = assessDataQuality(
            userPlayers: userPlayers,
            waiverPlayers: waiverPlayers,
            hasOpponent: matchup.opponentTeam != nil
        )

        onStage?(.writing)
        let evidence = EvidencePackBuilder(league: league, week: week).build(
            matchup: matchup,
            outlook: outlook,
            userLineup: currentLineup,
            userPlayers: userPlayers,
            opponentLineup: opponentLineup,
            opponentPlayers: opponentPlayers,
            waiverCandidates: waiverCandidates,
            assessments: assessments,
            moves: moves,
            watchItems: watchItems,
            dataQuality: dataQuality
        )

        // The configured narrator gets first refusal. If it fails, returns nothing
        // usable, or is rejected by the evidence validator, the on-device writer
        // takes over — a plainer sentence always beats a confident invented one.
        let narration: Narration
        var usedLanguageModel = false
        if let generated = try? await narrator.narrate(evidence),
           !generated.headline.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            narration = generated
            usedLanguageModel = narrator.isRemote
        } else {
            narration = (try? await TemplateNarrator().narrate(evidence))
                ?? Narration(
                    headline: "Your game plan is ready.",
                    positioning: "",
                    restingEasy: "Nothing else needs action right now."
                )
        }

        moves = applyNarration(narration, to: moves)

        let plan = GamePlan(
            week: week,
            season: league.season,
            headline: narration.headline,
            positioning: narration.positioning,
            outlook: outlook,
            moves: moves,
            watchItems: watchItems,
            restingEasy: narration.restingEasy,
            positionAssessments: assessments.sorted { $0.strengthScore < $1.strengthScore },
            biggestWeakness: weakness,
            dataQuality: dataQuality,
            inputFingerprint: Fingerprint.forAnalysis(
                league: league,
                matchup: matchup,
                waiverPool: waiverPool
            ),
            usedLanguageModel: usedLanguageModel
        )

        return WeeklyAnalysis(
            plan: plan,
            userPlayers: userPlayers,
            opponentPlayers: opponentPlayers,
            waiverCandidates: waiverCandidates,
            currentLineup: currentLineup,
            optimalLineup: optimalLineup,
            opponentLineup: opponentLineup,
            evidence: evidence
        )
    }

    // MARK: - Ranking

    /// Orders moves by urgency and impact, and caps the list.
    ///
    /// The cap is a product decision, not a technical one: a list of fifteen
    /// things is the same as no advice at all. Anything that does not make the cut
    /// is still reachable on the relevant tab.
    private func prioritize(_ moves: [Recommendation], limit: Int = 6) -> [Recommendation] {
        var seen = Set<String>()
        let deduplicated = moves.filter { seen.insert($0.id).inserted }

        return deduplicated
            .sorted { lhs, rhs in
                if lhs.priority != rhs.priority { return lhs.priority < rhs.priority }
                let lhsDelta = lhs.winProbabilityDelta ?? 0
                let rhsDelta = rhs.winProbabilityDelta ?? 0
                if abs(lhsDelta - rhsDelta) > 0.0001 { return lhsDelta > rhsDelta }
                if lhs.category != rhs.category {
                    return categoryRank(lhs.category) < categoryRank(rhs.category)
                }
                return lhs.confidenceScore > rhs.confidenceScore
            }
            .prefix(limit)
            .map { $0 }
    }

    private func categoryRank(_ category: Recommendation.Category) -> Int {
        switch category {
        case .lineup: return 0
        case .waiver: return 1
        case .roster: return 2
        case .trade: return 3
        case .watch: return 4
        }
    }

    /// Replaces engine wording with narrator wording where the narrator supplied
    /// it, leaving priority and evidence untouched.
    private func applyNarration(_ narration: Narration, to moves: [Recommendation]) -> [Recommendation] {
        guard !narration.moveSummaries.isEmpty else { return moves }
        return moves.map { move in
            guard let summary = narration.moveSummaries[move.id], !summary.isEmpty else { return move }
            var updated = move
            updated.summary = summary
            return updated
        }
    }

    // MARK: - Data quality

    private func assessDataQuality(
        userPlayers: [PlayerID: AnalyzedPlayer],
        waiverPlayers: [AnalyzedPlayer],
        hasOpponent: Bool
    ) -> DataQuality {
        let all = Array(userPlayers.values) + waiverPlayers
        guard !all.isEmpty else {
            return DataQuality(notes: ["No player data was available for this week."])
        }

        let withProjections = all.filter { $0.context.providerProjectedPoints != nil }.count
        let withUsage = all.filter { $0.context.bestUsage.hasData }.count
        let withInjury = all.filter { $0.player.injury.status != .active || $0.player.injury.practice != nil }.count
        let withWeather = all.filter { $0.context.environment?.effectiveWeather != nil }.count
        let withBetting = all.filter { $0.context.environment?.betting.overUnder != nil }.count

        var notes: [String] = []
        let projectionCoverage = Double(withProjections) / Double(all.count)
        if projectionCoverage < 0.5 {
            notes.append("Most projections here are calculated by Gameplan from usage, not published by your league.")
        }
        if withUsage == 0 {
            notes.append("No snap or target data was available, so role-based reasoning is limited.")
        }
        if withWeather == 0 {
            notes.append("No weather data — outdoor games aren't adjusted for conditions.")
        }
        if withBetting == 0 {
            notes.append("No betting market data is configured, so game-environment context is estimated.")
        }
        if !hasOpponent {
            notes.append("No opponent found for this week, so advice maximises points rather than win probability.")
        }

        return DataQuality(
            hasProviderProjections: projectionCoverage >= 0.5,
            hasUsageData: withUsage > all.count / 3,
            hasInjuryData: withInjury > 0,
            hasWeatherData: withWeather > 0,
            hasBettingData: withBetting > 0,
            notes: notes
        )
    }

    private func index(_ players: [AnalyzedPlayer]) -> [PlayerID: AnalyzedPlayer] {
        Dictionary(players.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    }
}
