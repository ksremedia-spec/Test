import Foundation

/// The complete, structured set of facts an interpretation layer is allowed to
/// use.
///
/// This type is the contract that keeps the language model honest. It is built
/// entirely from data the app has already verified or calculated, it is the only
/// thing sent to a model, and the validator that checks the model's reply refuses
/// any number that does not appear here. A model cannot invent a statistic it was
/// never given and cannot smuggle one past the check.
struct EvidencePack: Codable, Sendable {
    var week: Int
    var season: Int
    var league: LeagueFacts
    var matchup: MatchupFacts
    var roster: [PlayerFacts]
    var opponentStarters: [PlayerFacts]
    var waiverCandidates: [PlayerFacts]
    var positionAssessments: [PositionFacts]
    var proposedMoves: [MoveFacts]
    var watchItems: [WatchFacts]
    var dataGaps: [String]

    struct LeagueFacts: Codable, Sendable {
        var name: String
        var teamCount: Int
        var scoringFormat: String
        var startingLineup: [String]
        var waiverSystem: String
        var faabRemaining: Int?
        var continuity: String
        var isPlayoffWeek: Bool
    }

    struct MatchupFacts: Codable, Sendable {
        var opponentName: String?
        var userRecord: String
        var opponentRecord: String?
        var winProbability: Double
        var posture: String
        var projectedPoints: Double
        var projectedOpponentPoints: Double
        var projectedFloor: Double
        var projectedCeiling: Double
        var positionMargins: [String: Double]
    }

    struct PlayerFacts: Codable, Sendable {
        var id: String
        var name: String
        var position: String
        var team: String
        var opponent: String?
        var slot: String?
        var status: String
        var projectedPoints: Double
        var floor: Double
        var ceiling: Double
        var projectionSource: String
        var confidence: Double
        var snapShare: Double?
        var routeParticipation: Double?
        var targetShare: Double?
        var touchesPerGame: Double?
        var pointsPerGameSeason: Double?
        var pointsPerGameRecent: Double?
        var trend: String
        var matchupRank: Int?
        var weather: String?
    }

    struct PositionFacts: Codable, Sendable {
        var position: String
        var verdict: String
        var pointsAboveReplacement: Double
        var starterCount: Int
        var depthCount: Int
    }

    struct MoveFacts: Codable, Sendable {
        var id: String
        var action: String
        var title: String
        var priority: String
        var winProbabilityDelta: Double?
        var supportingEvidence: [String]
        var opposingEvidence: [String]
    }

    struct WatchFacts: Codable, Sendable {
        var title: String
        var detail: String
        var contingency: String?
    }

    /// Every numeric value that appears anywhere in the pack. The validator uses
    /// this to check that the model did not invent a figure.
    var allNumericValues: [Double] {
        var values: [Double] = [
            Double(week), Double(season), Double(league.teamCount),
            matchup.winProbability * 100,
            matchup.projectedPoints, matchup.projectedOpponentPoints,
            matchup.projectedFloor, matchup.projectedCeiling
        ]
        if let faab = league.faabRemaining { values.append(Double(faab)) }
        values.append(contentsOf: matchup.positionMargins.values)

        for group in [roster, opponentStarters, waiverCandidates] {
            for player in group {
                values.append(contentsOf: [player.projectedPoints, player.floor, player.ceiling])
                if let value = player.snapShare { values.append(value * 100) }
                if let value = player.routeParticipation { values.append(value * 100) }
                if let value = player.targetShare { values.append(value * 100) }
                if let value = player.touchesPerGame { values.append(value) }
                if let value = player.pointsPerGameSeason { values.append(value) }
                if let value = player.pointsPerGameRecent { values.append(value) }
                if let value = player.matchupRank { values.append(Double(value)) }
            }
        }
        for assessment in positionAssessments {
            values.append(assessment.pointsAboveReplacement)
            values.append(Double(assessment.starterCount))
            values.append(Double(assessment.depthCount))
        }
        for move in proposedMoves {
            if let delta = move.winProbabilityDelta { values.append(delta * 100) }
        }
        return values
    }
}
