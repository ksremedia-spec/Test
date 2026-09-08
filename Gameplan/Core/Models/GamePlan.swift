import Foundation

/// The strategic posture the engine adopts for the week, derived from the current
/// win probability. This is the single most important idea in the app: the right
/// move depends on whether you are ahead or behind, not just on projected points.
enum WeeklyPosture: String, Codable, Sendable {
    /// Comfortably ahead — protect the lead, prefer floor.
    case heavyFavorite
    /// Ahead but not safe — slight floor preference.
    case favorite
    /// A coin flip — take the highest expected points.
    case tossUp
    /// Behind — the extra points from a high-ceiling player are worth more than
    /// the ones a safe player gives back.
    case underdog
    /// Well behind — maximise variance.
    case heavyUnderdog

    static func from(winProbability: Double) -> WeeklyPosture {
        switch winProbability {
        case 0.72...: return .heavyFavorite
        case 0.58..<0.72: return .favorite
        case 0.42..<0.58: return .tossUp
        case 0.28..<0.42: return .underdog
        default: return .heavyUnderdog
        }
    }

    var displayName: String {
        switch self {
        case .heavyFavorite: return "Heavy favorite"
        case .favorite: return "Favored"
        case .tossUp: return "Toss-up"
        case .underdog: return "Underdog"
        case .heavyUnderdog: return "Big underdog"
        }
    }

    /// One sentence explaining what the posture means for decisions.
    var strategyStatement: String {
        switch self {
        case .heavyFavorite:
            return "You're in control. Take the safest lineup — you don't need a big week, you need to avoid a bad one."
        case .favorite:
            return "You're ahead on paper. Lean toward reliable floors and avoid unnecessary risk."
        case .tossUp:
            return "This one is close. Play the highest expected points and don't overthink it."
        case .underdog:
            return "You're behind on paper. Favor upside — a safe bench player doesn't help you here."
        case .heavyUnderdog:
            return "You need a big week. Take the swings, even the uncomfortable ones."
        }
    }

    var favorsFloor: Bool { self == .heavyFavorite || self == .favorite }
    var favorsCeiling: Bool { self == .underdog || self == .heavyUnderdog }
}

/// Something the user should keep an eye on but cannot act on yet.
struct WatchItem: Codable, Hashable, Identifiable, Sendable {
    enum Kind: String, Codable, Sendable {
        case injury
        case weather
        case depthChart
        case usage
        case news
        case gameTime

        var symbolName: String {
            switch self {
            case .injury: return "cross.case.fill"
            case .weather: return "cloud.rain.fill"
            case .depthChart: return "list.number"
            case .usage: return "chart.line.uptrend.xyaxis"
            case .news: return "newspaper.fill"
            case .gameTime: return "clock.fill"
            }
        }
    }

    var id: String
    var kind: Kind
    var title: String
    var detail: String
    /// What the user should do if the situation resolves badly.
    var contingency: String?
    var playerID: PlayerID?
    var checkBy: Date?
    var checkByDescription: String?

    init(
        id: String = UUID().uuidString,
        kind: Kind,
        title: String,
        detail: String,
        contingency: String? = nil,
        playerID: PlayerID? = nil,
        checkBy: Date? = nil,
        checkByDescription: String? = nil
    ) {
        self.id = id
        self.kind = kind
        self.title = title
        self.detail = detail
        self.contingency = contingency
        self.playerID = playerID
        self.checkBy = checkBy
        self.checkByDescription = checkByDescription
    }
}

/// Positional strength relative to what the rest of the league starts.
struct PositionAssessment: Codable, Hashable, Identifiable, Sendable {
    var position: Position
    /// Points above or below the league's replacement level, summed across the
    /// slots this position fills.
    var pointsAboveReplacement: Double
    /// -1...1 where negative is a weakness.
    var strengthScore: Double
    var starterCount: Int
    var depthCount: Int
    var headline: String

    var id: String { position.rawValue }

    var isWeakness: Bool { strengthScore < -0.25 }
    var isStrength: Bool { strengthScore > 0.25 }

    var descriptor: String {
        switch strengthScore {
        case 0.5...: return "Strong"
        case 0.25..<0.5: return "Above average"
        case -0.25..<0.25: return "Adequate"
        case -0.5..<(-0.25): return "Thin"
        default: return "Problem area"
        }
    }
}

/// How good the underlying data was. Shown to the user so confident-sounding
/// advice is never mistaken for certainty it does not have.
struct DataQuality: Codable, Hashable, Sendable {
    var hasProviderProjections: Bool
    var hasUsageData: Bool
    var hasInjuryData: Bool
    var hasWeatherData: Bool
    var hasBettingData: Bool
    var notes: [String]

    init(
        hasProviderProjections: Bool = false,
        hasUsageData: Bool = false,
        hasInjuryData: Bool = false,
        hasWeatherData: Bool = false,
        hasBettingData: Bool = false,
        notes: [String] = []
    ) {
        self.hasProviderProjections = hasProviderProjections
        self.hasUsageData = hasUsageData
        self.hasInjuryData = hasInjuryData
        self.hasWeatherData = hasWeatherData
        self.hasBettingData = hasBettingData
        self.notes = notes
    }

    /// 0...1 — how much of the ideal evidence set we actually had.
    var completeness: Double {
        let flags = [
            hasProviderProjections, hasUsageData, hasInjuryData,
            hasWeatherData, hasBettingData
        ]
        return Double(flags.filter { $0 }.count) / Double(flags.count)
    }

    var descriptor: String {
        switch completeness {
        case 0.8...: return "Complete data"
        case 0.5..<0.8: return "Good data"
        case 0.3..<0.5: return "Partial data"
        default: return "Limited data"
        }
    }
}

/// The user's projected position in this week's matchup.
struct MatchupOutlook: Codable, Hashable, Sendable {
    var winProbability: Double
    var posture: WeeklyPosture
    var projectedPoints: Double
    var projectedOpponentPoints: Double
    var projectedFloor: Double
    var projectedCeiling: Double
    var opponentFloor: Double
    var opponentCeiling: Double
    var positionAdvantages: [PositionAdvantage]

    init(
        winProbability: Double,
        projectedPoints: Double,
        projectedOpponentPoints: Double,
        projectedFloor: Double,
        projectedCeiling: Double,
        opponentFloor: Double,
        opponentCeiling: Double,
        positionAdvantages: [PositionAdvantage] = []
    ) {
        self.winProbability = min(0.99, max(0.01, winProbability))
        self.posture = WeeklyPosture.from(winProbability: winProbability)
        self.projectedPoints = projectedPoints
        self.projectedOpponentPoints = projectedOpponentPoints
        self.projectedFloor = projectedFloor
        self.projectedCeiling = projectedCeiling
        self.opponentFloor = opponentFloor
        self.opponentCeiling = opponentCeiling
        self.positionAdvantages = positionAdvantages
    }

    var projectedMargin: Double { projectedPoints - projectedOpponentPoints }
}

/// Side-by-side comparison at one position group.
struct PositionAdvantage: Codable, Hashable, Identifiable, Sendable {
    var position: Position
    var userProjected: Double
    var opponentProjected: Double
    var userCeiling: Double
    var opponentCeiling: Double

    var id: String { position.rawValue }

    var margin: Double { userProjected - opponentProjected }

    /// Normalised -1...1 for the advantage bars.
    var normalizedMargin: Double {
        let total = max(1, userProjected + opponentProjected)
        return max(-1, min(1, margin / (total / 2)))
    }

    var verdict: String {
        switch margin {
        case 6...: return "Big edge"
        case 2..<6: return "Edge"
        case -2..<2: return "Even"
        case -6..<(-2): return "Disadvantage"
        default: return "Big disadvantage"
        }
    }
}

/// The centrepiece of the app: one week, one plan.
struct GamePlan: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var week: Int
    var season: Int
    var generatedAt: Date
    /// The one-line answer to "how am I doing?".
    var headline: String
    /// Two or three sentences of context under the headline.
    var positioning: String
    var outlook: MatchupOutlook
    /// Ranked actions. Already deduplicated and capped.
    var moves: [Recommendation]
    var watchItems: [WatchItem]
    /// What explicitly does not need attention.
    var restingEasy: String
    var positionAssessments: [PositionAssessment]
    var biggestWeakness: PositionAssessment?
    var dataQuality: DataQuality
    /// Fingerprint of the inputs. Identical inputs reuse the cached plan instead of
    /// re-running analysis or calling a language model.
    var inputFingerprint: String
    /// True when the prose came from a language model rather than the built-in
    /// deterministic writer.
    var usedLanguageModel: Bool

    init(
        id: String = UUID().uuidString,
        week: Int,
        season: Int,
        generatedAt: Date = Date(),
        headline: String,
        positioning: String,
        outlook: MatchupOutlook,
        moves: [Recommendation],
        watchItems: [WatchItem],
        restingEasy: String,
        positionAssessments: [PositionAssessment],
        biggestWeakness: PositionAssessment?,
        dataQuality: DataQuality,
        inputFingerprint: String,
        usedLanguageModel: Bool = false
    ) {
        self.id = id
        self.week = week
        self.season = season
        self.generatedAt = generatedAt
        self.headline = headline
        self.positioning = positioning
        self.outlook = outlook
        self.moves = moves
        self.watchItems = watchItems
        self.restingEasy = restingEasy
        self.positionAssessments = positionAssessments
        self.biggestWeakness = biggestWeakness
        self.dataQuality = dataQuality
        self.inputFingerprint = inputFingerprint
        self.usedLanguageModel = usedLanguageModel
    }

    var urgentMoves: [Recommendation] { moves.filter { $0.priority == .mustDo } }

    var actionableMoves: [Recommendation] {
        moves.filter { $0.priority == .mustDo || $0.priority == .stronglyConsider }
    }

    var hasUrgentWork: Bool { !urgentMoves.isEmpty }
}
