import Foundation

/// Where a number came from. This is surfaced in the UI so the user always knows
/// whether they are looking at a provider's published projection or something the
/// app worked out itself.
enum EvidenceLevel: String, Codable, CaseIterable, Sendable {
    /// Directly observed or published by a data source.
    case measured
    /// Computed by this app from measured inputs.
    case derived
    /// A model assumption used because real data was unavailable.
    case estimated

    var displayName: String {
        switch self {
        case .measured: return "Measured"
        case .derived: return "Calculated"
        case .estimated: return "Estimated"
        }
    }

    var disclosure: String {
        switch self {
        case .measured: return "From your league's data"
        case .derived: return "Calculated by Gameplan"
        case .estimated: return "Model estimate — treat as approximate"
        }
    }
}

/// A distribution over a player's fantasy points for one week.
///
/// `mean` is the expectation, `floor` the 10th percentile and `ceiling` the 90th.
/// The spread is what makes floor-vs-ceiling advice possible.
struct Projection: Codable, Hashable, Sendable {
    var mean: Double
    var standardDeviation: Double
    var floor: Double
    var ceiling: Double
    var source: EvidenceLevel
    /// 0...1 confidence in the mean, driven by sample size and injury certainty.
    var confidence: Double

    init(
        mean: Double,
        standardDeviation: Double,
        floor: Double,
        ceiling: Double,
        source: EvidenceLevel,
        confidence: Double
    ) {
        self.mean = mean
        self.standardDeviation = standardDeviation
        self.floor = floor
        self.ceiling = ceiling
        self.source = source
        self.confidence = min(1, max(0, confidence))
    }

    static let zero = Projection(
        mean: 0, standardDeviation: 0, floor: 0, ceiling: 0, source: .estimated, confidence: 0
    )

    var variance: Double { standardDeviation * standardDeviation }

    /// Ceiling minus mean, relative to the mean. High values mean boom/bust.
    var upsideRatio: Double {
        mean > 0.5 ? (ceiling - mean) / mean : 0
    }

    /// Constructs a projection from a mean and a coefficient of variation, using a
    /// mildly right-skewed shape — fantasy scoring has a hard floor at zero and a
    /// long upper tail, so a symmetric normal band would misstate both ends.
    static func fromMean(
        _ mean: Double,
        coefficientOfVariation: Double,
        source: EvidenceLevel,
        confidence: Double
    ) -> Projection {
        let safeMean = max(0, mean)
        let deviation = max(0.5, safeMean * max(0.05, coefficientOfVariation))
        let floor = max(0, safeMean - 1.15 * deviation)
        let ceiling = safeMean + 1.45 * deviation
        return Projection(
            mean: safeMean,
            standardDeviation: deviation,
            floor: floor,
            ceiling: ceiling,
            source: source,
            confidence: confidence
        )
    }

    /// Scales the whole distribution by a multiplier (matchup, weather, and so on).
    func scaled(by multiplier: Double) -> Projection {
        Projection(
            mean: mean * multiplier,
            standardDeviation: standardDeviation * multiplier,
            floor: floor * multiplier,
            ceiling: ceiling * multiplier,
            source: source == .measured ? .derived : source,
            confidence: confidence
        )
    }

    /// Applies a probability that the player does not play at all. The mean scales
    /// down, the floor collapses toward zero, and variance grows — which is exactly
    /// why a questionable player is a bad choice when you are already favoured.
    func withPlayProbability(_ probability: Double) -> Projection {
        guard probability < 1 else { return self }
        let p = max(0, min(1, probability))
        let newMean = mean * p
        // Variance of a mixture of (play) and (do not play, score 0).
        let mixtureVariance = p * (variance + mean * mean) - (newMean * newMean)
        let newDeviation = max(0.5, mixtureVariance.squareRoot())
        return Projection(
            mean: newMean,
            standardDeviation: newDeviation,
            floor: p >= 0.9 ? floor * p : 0,
            ceiling: ceiling,
            source: .derived,
            confidence: confidence * (0.6 + 0.4 * p)
        )
    }
}
