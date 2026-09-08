import Foundation

/// The scoring rules that turn box-score events into fantasy points.
///
/// The engine never assumes a format. Every piece of advice that depends on
/// scoring (reception volume, TE premium, superflex QB value) reads from here.
struct ScoringSettings: Codable, Hashable, Sendable {
    var passingYardsPerPoint: Double
    var passingTouchdown: Double
    var interception: Double
    var rushingYardsPerPoint: Double
    var rushingTouchdown: Double
    var receivingYardsPerPoint: Double
    var receivingTouchdown: Double
    var pointsPerReception: Double
    /// Extra points per reception for tight ends only.
    var tightEndReceptionBonus: Double
    var fumbleLost: Double
    var twoPointConversion: Double

    init(
        passingYardsPerPoint: Double = 25,
        passingTouchdown: Double = 4,
        interception: Double = -2,
        rushingYardsPerPoint: Double = 10,
        rushingTouchdown: Double = 6,
        receivingYardsPerPoint: Double = 10,
        receivingTouchdown: Double = 6,
        pointsPerReception: Double = 1,
        tightEndReceptionBonus: Double = 0,
        fumbleLost: Double = -2,
        twoPointConversion: Double = 2
    ) {
        self.passingYardsPerPoint = passingYardsPerPoint
        self.passingTouchdown = passingTouchdown
        self.interception = interception
        self.rushingYardsPerPoint = rushingYardsPerPoint
        self.rushingTouchdown = rushingTouchdown
        self.receivingYardsPerPoint = receivingYardsPerPoint
        self.receivingTouchdown = receivingTouchdown
        self.pointsPerReception = pointsPerReception
        self.tightEndReceptionBonus = tightEndReceptionBonus
        self.fumbleLost = fumbleLost
        self.twoPointConversion = twoPointConversion
    }

    static let ppr = ScoringSettings(pointsPerReception: 1)
    static let halfPPR = ScoringSettings(pointsPerReception: 0.5)
    static let standard = ScoringSettings(pointsPerReception: 0)

    /// Short label used in headers and league summaries.
    var formatName: String {
        let base: String
        switch pointsPerReception {
        case 0: base = "Standard"
        case 0.5: base = "Half PPR"
        case 1: base = "Full PPR"
        default: base = String(format: "%.2g PPR", pointsPerReception)
        }
        return tightEndReceptionBonus > 0 ? "\(base) · TE Premium" : base
    }

    var isTightEndPremium: Bool { tightEndReceptionBonus > 0 }

    /// How much a reception is worth for a given position under these rules.
    func receptionValue(for position: Position) -> Double {
        position == .tightEnd ? pointsPerReception + tightEndReceptionBonus : pointsPerReception
    }

    /// Weight applied to target-based evidence. In PPR a target is worth much more
    /// than in standard scoring, so target share carries more of the argument.
    var targetEvidenceWeight: Double {
        0.6 + (pointsPerReception * 0.4)
    }
}
