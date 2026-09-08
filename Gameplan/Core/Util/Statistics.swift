import Foundation

/// Small statistics helpers used by the analysis engine.
///
/// Kept deliberately tiny and dependency-free: the engine's maths should be easy
/// to read and easy to test.
enum Statistics {

    /// Cumulative distribution function of the standard normal distribution.
    ///
    /// Uses the Abramowitz & Stegun 7.1.26 approximation of `erf`, which is
    /// accurate to about 1.5e-7 — far more precision than fantasy football
    /// projections deserve, and fast enough to call thousands of times while the
    /// optimizer searches lineups.
    static func normalCDF(_ x: Double) -> Double {
        0.5 * (1.0 + erfApproximation(x / 2.0.squareRoot()))
    }

    private static func erfApproximation(_ x: Double) -> Double {
        let sign: Double = x < 0 ? -1 : 1
        let absoluteX = abs(x)

        let a1 = 0.254829592
        let a2 = -0.284496736
        let a3 = 1.421413741
        let a4 = -1.453152027
        let a5 = 1.061405429
        let p = 0.3275911

        let t = 1.0 / (1.0 + p * absoluteX)
        let y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * exp(-absoluteX * absoluteX)
        return sign * y
    }

    /// Probability that a draw from `Normal(meanA, sdA)` exceeds a draw from
    /// `Normal(meanB, sdB)`, assuming independence between the two teams.
    ///
    /// Fantasy scores are not perfectly normal, but the sum of eight or nine
    /// starters is close enough that this is a sound approximation — and it is
    /// transparent in a way a black-box simulation is not.
    static func probabilityOfExceeding(
        meanA: Double,
        deviationA: Double,
        meanB: Double,
        deviationB: Double
    ) -> Double {
        let combinedVariance = (deviationA * deviationA) + (deviationB * deviationB)
        guard combinedVariance > 0.0001 else {
            return meanA > meanB ? 1 : (meanA < meanB ? 0 : 0.5)
        }
        return normalCDF((meanA - meanB) / combinedVariance.squareRoot())
    }

    /// Combines independent projections into a team total.
    ///
    /// Real lineups have positive correlation (a quarterback and their receiver
    /// score together), which fattens both tails. `correlation` inflates the
    /// team-level variance to account for that without needing a full covariance
    /// matrix the data cannot support.
    static func combine(
        means: [Double],
        deviations: [Double],
        correlation: Double = 0.12
    ) -> (mean: Double, deviation: Double) {
        let mean = means.reduce(0, +)
        let independentVariance = deviations.reduce(0) { $0 + $1 * $1 }
        let sumOfDeviations = deviations.reduce(0, +)
        // Variance of a sum with uniform pairwise correlation rho:
        // sum(var) + rho * (sum(sd)^2 - sum(var))
        let clampedCorrelation = max(0, min(1, correlation))
        let pairwiseTerm = (sumOfDeviations * sumOfDeviations) - independentVariance
        let variance = independentVariance + clampedCorrelation * pairwiseTerm
        return (mean, max(0, variance).squareRoot())
    }

    static func mean(_ values: [Double]) -> Double? {
        guard !values.isEmpty else { return nil }
        return values.reduce(0, +) / Double(values.count)
    }

    static func standardDeviation(_ values: [Double]) -> Double? {
        guard values.count >= 2, let average = mean(values) else { return nil }
        let sumSquares = values.reduce(0) { $0 + ($1 - average) * ($1 - average) }
        return (sumSquares / Double(values.count - 1)).squareRoot()
    }

    /// Linearly maps `value` from one range to another, clamped to the output.
    static func remap(
        _ value: Double,
        from source: ClosedRange<Double>,
        to destination: ClosedRange<Double>
    ) -> Double {
        guard source.upperBound > source.lowerBound else { return destination.lowerBound }
        let normalized = (value - source.lowerBound) / (source.upperBound - source.lowerBound)
        let clamped = max(0, min(1, normalized))
        return destination.lowerBound + clamped * (destination.upperBound - destination.lowerBound)
    }
}
