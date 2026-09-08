import Foundation

/// A player with a projection and the evidence behind it.
///
/// This is the output of the *calculation* layer. Nothing in it is prose; the
/// narration layer turns these factors into sentences, and it can only use
/// factors that appear here.
struct AnalyzedPlayer: Identifiable, Hashable, Sendable {
    var context: PlayerContext
    var projection: Projection
    var factors: [RecommendationFactor]
    /// 0...1 measure of how much opportunity the player is getting.
    var opportunityScore: Double?
    var trend: UsageTrend

    var id: PlayerID { context.id }
    var player: Player { context.player }
    var position: Position { player.position }

    /// Points a heavy favourite should optimise for.
    var floorValue: Double { projection.floor }
    /// Points an underdog should optimise for.
    var ceilingValue: Double { projection.ceiling }
}

/// Turns observed facts into a weekly points distribution.
///
/// The engine keeps a strict separation between three things:
/// facts that came from a data source, arithmetic this app performed, and model
/// assumptions used where data was missing. Every factor it emits is tagged with
/// which of the three it is.
struct PlayerProjectionEngine {
    var league: League
    var week: Int

    init(league: League, week: Int) {
        self.league = league
        self.week = week
    }

    func analyze(_ context: PlayerContext) -> AnalyzedPlayer {
        var factors: [RecommendationFactor] = []
        let player = context.player
        let usage = context.bestUsage

        // MARK: Base expectation

        let providerProjection = context.providerProjectedPoints
        let usageProjection = derivedMean(from: context)

        var mean: Double
        var source: EvidenceLevel
        // Provider projections already fold in matchup and conditions, so any
        // adjustment the app layers on top is applied at reduced weight to avoid
        // counting the same information twice.
        var adjustmentWeight: Double

        if let providerProjection, providerProjection > 0 {
            mean = providerProjection
            source = .measured
            adjustmentWeight = 0.5
            factors.append(RecommendationFactor(
                id: "\(player.id.rawValue)-projection",
                summary: String(format: "League projection: %.1f points", providerProjection),
                detail: "Published by your league's data source.",
                direction: .neutral,
                evidence: .measured
            ))
        } else if let usageProjection {
            mean = usageProjection
            source = .derived
            adjustmentWeight = 1.0
            factors.append(RecommendationFactor(
                id: "\(player.id.rawValue)-projection",
                summary: String(format: "Estimated %.1f points from recent usage", usageProjection),
                detail: "No published projection was available, so this is calculated from the player's own workload.",
                direction: .neutral,
                evidence: .derived
            ))
        } else {
            mean = 0
            source = .estimated
            adjustmentWeight = 0
            factors.append(RecommendationFactor(
                id: "\(player.id.rawValue)-noData",
                summary: "No projection or usage data available",
                detail: "Gameplan can't say anything useful about this player yet.",
                direction: .neutral,
                evidence: .estimated
            ))
        }

        // MARK: Adjustments

        if mean > 0, let environment = context.environment {
            if let matchup = environment.defensiveMatchup {
                let multiplier = blend(matchup.multiplier, weight: adjustmentWeight)
                mean *= multiplier
                if let descriptor = matchup.descriptor, abs(multiplier - 1) > 0.005 {
                    factors.append(RecommendationFactor(
                        id: "\(player.id.rawValue)-matchup",
                        summary: descriptor,
                        detail: matchupDetail(matchup, position: player.position),
                        direction: matchup.isFavorable ? .supporting : (matchup.isTough ? .opposing : .neutral),
                        evidence: matchup.pointsAllowedPerGame != nil ? .measured : .derived
                    ))
                }
            }

            if let weather = environment.effectiveWeather, weather.isNoteworthy {
                let raw = weatherMultiplier(weather, for: player.position)
                let multiplier = blend(raw, weight: adjustmentWeight)
                mean *= multiplier
                factors.append(RecommendationFactor(
                    id: "\(player.id.rawValue)-weather",
                    summary: weather.shortDescription,
                    detail: weatherDetail(weather, position: player.position),
                    direction: raw < 0.995 ? .opposing : (raw > 1.005 ? .supporting : .neutral),
                    evidence: .measured
                ))
            }

            if let implied = environment.betting.impliedTeamTotal {
                factors.append(RecommendationFactor(
                    id: "\(player.id.rawValue)-implied",
                    summary: String(format: "%.1f implied team total", implied),
                    detail: "How many points the betting market expects this offense to score.",
                    direction: implied >= 24 ? .supporting : (implied <= 18 ? .opposing : .neutral),
                    evidence: .measured
                ))
            }
        }

        // MARK: Usage evidence

        factors.append(contentsOf: usageFactors(for: context, usage: usage))

        let trend = context.usageTrend
        if trend == .rising || trend == .falling {
            factors.append(RecommendationFactor(
                id: "\(player.id.rawValue)-trend",
                summary: trend.displayName,
                detail: trendDetail(context, trend: trend),
                direction: trend == .rising ? .supporting : .opposing,
                evidence: .derived
            ))
        }

        // MARK: Spread

        let deviation = spread(for: context, mean: mean)
        var projection = Projection(
            mean: mean,
            standardDeviation: deviation,
            floor: max(0, mean - 1.15 * deviation),
            ceiling: mean + 1.45 * deviation,
            source: source,
            confidence: confidence(for: context, hasProviderProjection: providerProjection != nil)
        )

        // MARK: Availability

        if player.isOnBye(week: week) {
            projection = .zero
            factors.append(RecommendationFactor(
                id: "\(player.id.rawValue)-bye",
                summary: "On bye this week",
                detail: "This player's NFL team isn't playing in week \(week).",
                direction: .opposing,
                evidence: .measured
            ))
        } else {
            let playProbability = player.injury.effectivePlayProbability
            if playProbability < 1 {
                projection = projection.withPlayProbability(playProbability)
                factors.append(RecommendationFactor(
                    id: "\(player.id.rawValue)-injury",
                    summary: injurySummary(player.injury),
                    detail: injuryDetail(player.injury, playProbability: playProbability),
                    direction: .opposing,
                    evidence: .measured
                ))
            }
        }

        return AnalyzedPlayer(
            context: context,
            projection: projection,
            factors: factors,
            opportunityScore: usage.opportunityScore(for: player.position),
            trend: trend
        )
    }

    // MARK: - Base expectation from usage

    /// Weighted average of recent and season scoring, favouring recent form.
    private func derivedMean(from context: PlayerContext) -> Double? {
        let recent = context.recentUsage.fantasyPointsPerGame
        let season = context.seasonUsage.fantasyPointsPerGame

        switch (recent, season) {
        case (let recent?, let season?):
            return recent * 0.62 + season * 0.38
        case (let recent?, nil):
            return recent
        case (nil, let season?):
            return season
        default:
            let scores = context.playedGames.map(\.fantasyPoints)
            return Statistics.mean(scores)
        }
    }

    /// Scales an adjustment toward 1 when the base already includes it.
    private func blend(_ multiplier: Double, weight: Double) -> Double {
        1 + (multiplier - 1) * max(0, min(1, weight))
    }

    // MARK: - Spread

    /// Prefers the player's own realised week-to-week variation, and falls back to
    /// a positional assumption only when there are too few games to measure it.
    private func spread(for context: PlayerContext, mean: Double) -> Double {
        let injuryMultiplier = context.player.injury.status.varianceMultiplier

        if let observed = context.observedScoringDeviation, observed > 0 {
            // Rescale the observed spread to the current expectation so a player
            // whose role just changed is not saddled with their old variance.
            let observedMean = Statistics.mean(context.playedGames.map(\.fantasyPoints)) ?? mean
            let ratio = observedMean > 1 ? mean / observedMean : 1
            let scaled = observed * min(1.6, max(0.6, ratio))
            return max(1.0, scaled * injuryMultiplier)
        }

        let base = max(1.0, mean * context.position.baselineVariation)
        return base * injuryMultiplier
    }

    /// How much to trust the mean, from sample size, data availability and health.
    private func confidence(for context: PlayerContext, hasProviderProjection: Bool) -> Double {
        var score = hasProviderProjection ? 0.62 : 0.42

        let games = context.playedGames.count
        score += Statistics.remap(Double(games), from: 0...6, to: 0...0.20)

        let usage = context.bestUsage
        if usage.snapShare != nil || usage.routeParticipation != nil { score += 0.06 }
        if usage.targetShare != nil || usage.carriesPerGame != nil { score += 0.06 }
        if context.environment?.defensiveMatchup != nil { score += 0.04 }

        switch context.player.injury.status {
        case .questionable: score -= 0.16
        case .doubtful: score -= 0.24
        case .probable: score -= 0.04
        default: break
        }
        if context.player.injury.practice == .didNotParticipate { score -= 0.08 }

        return min(0.95, max(0.08, score))
    }

    // MARK: - Factor text

    private func usageFactors(for context: PlayerContext, usage: PlayerUsage) -> [RecommendationFactor] {
        var factors: [RecommendationFactor] = []
        let id = context.id.rawValue
        let position = context.position

        if let routes = usage.routeParticipation, position.isReceivingDriven {
            factors.append(RecommendationFactor(
                id: "\(id)-routes",
                summary: "\(percent(routes)) route participation",
                detail: "Ran a route on \(percent(routes)) of his team's dropbacks.",
                direction: routes >= 0.80 ? .supporting : (routes < 0.55 ? .opposing : .neutral),
                evidence: .measured
            ))
        }

        if let share = usage.targetShare, position.isReceivingDriven {
            let weight = league.scoring.targetEvidenceWeight
            factors.append(RecommendationFactor(
                id: "\(id)-targetShare",
                summary: "\(percent(share)) target share",
                detail: weight > 0.85
                    ? "Volume matters more than usual in \(league.scoring.formatName)."
                    : "Share of his team's passing targets.",
                direction: share >= 0.22 ? .supporting : (share < 0.13 ? .opposing : .neutral),
                evidence: .measured
            ))
        }

        if let snaps = usage.snapShare, !position.isReceivingDriven || usage.routeParticipation == nil {
            factors.append(RecommendationFactor(
                id: "\(id)-snaps",
                summary: "\(percent(snaps)) snap share",
                detail: "Share of his team's offensive snaps.",
                direction: snaps >= 0.70 ? .supporting : (snaps < 0.45 ? .opposing : .neutral),
                evidence: .measured
            ))
        }

        if let touches = usage.touchesPerGame, position == .runningBack {
            factors.append(RecommendationFactor(
                id: "\(id)-touches",
                summary: String(format: "%.1f touches per game", touches),
                detail: "Carries plus targets — the clearest signal of a running back's role.",
                direction: touches >= 15 ? .supporting : (touches < 9 ? .opposing : .neutral),
                evidence: .measured
            ))
        }

        if let redZone = usage.redZoneTouchesPerGame, redZone >= 1.5 {
            factors.append(RecommendationFactor(
                id: "\(id)-redzone",
                summary: String(format: "%.1f red-zone touches per game", redZone),
                detail: "Scoring chances are where weekly ceilings come from.",
                direction: .supporting,
                evidence: .measured
            ))
        }

        if let depth = context.player.depthChartRank, depth >= 3 {
            factors.append(RecommendationFactor(
                id: "\(id)-depth",
                summary: "Number \(depth) on the depth chart at his position",
                detail: "His role depends on the players ahead of him staying healthy.",
                direction: .opposing,
                evidence: .measured
            ))
        }

        return factors
    }

    private func trendDetail(_ context: PlayerContext, trend: UsageTrend) -> String {
        let played = context.playedGames.sorted { $0.week < $1.week }
        let recent = Array(played.suffix(3))
        guard let recentAverage = Statistics.mean(recent.map(\.fantasyPoints)) else {
            return trend.displayName
        }
        let earlier = Array(played.dropLast(3))
        guard let earlierAverage = Statistics.mean(earlier.map(\.fantasyPoints)) else {
            return String(format: "Averaging %.1f points over his last %d games.", recentAverage, recent.count)
        }
        return String(
            format: "%.1f points per game over his last %d, against %.1f before that.",
            recentAverage, recent.count, earlierAverage
        )
    }

    private func matchupDetail(_ matchup: DefensiveMatchup, position: Position) -> String {
        guard let rank = matchup.rankAgainstPosition else {
            return "Facing \(matchup.opponentAbbreviation)."
        }
        let ordinal = ordinalString(rank)
        return "\(matchup.opponentAbbreviation) ranks \(ordinal) against \(position.abbreviation)s, where 32nd is the easiest matchup in the league."
    }

    private func weatherMultiplier(_ weather: WeatherConditions, for position: Position) -> Double {
        switch position {
        case .quarterback, .wideReceiver, .tightEnd:
            return weather.passingMultiplier
        case .runningBack:
            return weather.rushingMultiplier
        case .kicker:
            // Kickers are hit hardest by wind.
            return min(1, weather.passingMultiplier - 0.03)
        case .defense:
            // Bad weather produces turnovers and stalled drives.
            return weather.passingMultiplier < 1 ? 1.04 : 1.0
        }
    }

    private func weatherDetail(_ weather: WeatherConditions, position: Position) -> String {
        var pieces: [String] = []
        if let wind = weather.windMilesPerHour, wind >= 15 {
            pieces.append("\(Int(wind.rounded())) mph wind suppresses passing and kicking")
        }
        if let precipitation = weather.precipitationChance, precipitation >= 0.5 {
            pieces.append("rain tends to push teams toward the run")
        }
        if let temperature = weather.temperatureFahrenheit, temperature <= 20 {
            pieces.append("extreme cold reduces scoring")
        }
        if pieces.isEmpty { return weather.shortDescription }
        return sentenceCased(pieces.joined(separator: ", ")) + "."
    }

    /// Capitalises the first character without touching the rest, which matters
    /// because these strings contain team abbreviations.
    private func sentenceCased(_ value: String) -> String {
        guard let first = value.first else { return value }
        return String(first).uppercased() + value.dropFirst()
    }

    private func injurySummary(_ report: InjuryReport) -> String {
        if report.status.isUnavailable { return "Ruled \(report.status.displayName.lowercased())" }
        return "Listed \(report.status.displayName.lowercased())"
    }

    private func injuryDetail(_ report: InjuryReport, playProbability: Double) -> String {
        var pieces: [String] = []
        if let practice = report.practice { pieces.append(practice.displayName.lowercased()) }
        if let designation = report.designation, !designation.isEmpty,
           designation.uppercased() != report.status.rawValue {
            pieces.append(designation.lowercased())
        }
        let odds = "roughly \(Int((playProbability * 100).rounded()))% likely to play"
        if pieces.isEmpty { return sentenceCased(odds) + "." }
        return sentenceCased(pieces.joined(separator: ", ")) + " — " + odds + "."
    }

    private func percent(_ value: Double) -> String {
        "\(Int((value * 100).rounded()))%"
    }

    private func ordinalString(_ value: Int) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .ordinal
        return formatter.string(from: NSNumber(value: value)) ?? "\(value)"
    }
}
