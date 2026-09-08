import XCTest
@testable import Gameplan

/// The maths everything else rests on. If these are wrong, every recommendation
/// in the app is wrong in a way no UI test would catch.
final class StatisticsTests: XCTestCase {

    func testNormalCDFMatchesKnownValues() {
        XCTAssertEqual(Statistics.normalCDF(0), 0.5, accuracy: 1e-6)
        XCTAssertEqual(Statistics.normalCDF(1), 0.8413447, accuracy: 1e-5)
        XCTAssertEqual(Statistics.normalCDF(-1), 0.1586553, accuracy: 1e-5)
        XCTAssertEqual(Statistics.normalCDF(1.96), 0.9750021, accuracy: 1e-5)
        XCTAssertEqual(Statistics.normalCDF(-2.58), 0.0049400, accuracy: 1e-4)
    }

    func testNormalCDFIsMonotonicAndBounded() {
        var previous = 0.0
        for step in stride(from: -4.0, through: 4.0, by: 0.25) {
            let value = Statistics.normalCDF(step)
            XCTAssertGreaterThanOrEqual(value, previous)
            XCTAssertGreaterThanOrEqual(value, 0)
            XCTAssertLessThanOrEqual(value, 1)
            previous = value
        }
    }

    func testEqualTeamsAreACoinFlip() {
        let probability = Statistics.probabilityOfExceeding(
            meanA: 110, deviationA: 22, meanB: 110, deviationB: 22
        )
        XCTAssertEqual(probability, 0.5, accuracy: 1e-6)
    }

    func testHigherMeanWinsMoreOften() {
        let probability = Statistics.probabilityOfExceeding(
            meanA: 120, deviationA: 20, meanB: 105, deviationB: 20
        )
        XCTAssertGreaterThan(probability, 0.6)
        XCTAssertLessThan(probability, 0.85)
    }

    func testZeroVarianceFallsBackToComparingMeans() {
        XCTAssertEqual(
            Statistics.probabilityOfExceeding(meanA: 100, deviationA: 0, meanB: 90, deviationB: 0),
            1.0
        )
        XCTAssertEqual(
            Statistics.probabilityOfExceeding(meanA: 90, deviationA: 0, meanB: 100, deviationB: 0),
            0.0
        )
    }

    func testCombineSumsMeansAndInflatesVarianceWithCorrelation() {
        let means = [20.0, 15.0, 12.0]
        let deviations = [7.0, 6.0, 5.0]

        let independent = Statistics.combine(means: means, deviations: deviations, correlation: 0)
        let correlated = Statistics.combine(means: means, deviations: deviations, correlation: 0.2)

        XCTAssertEqual(independent.mean, 47, accuracy: 1e-9)
        XCTAssertEqual(correlated.mean, 47, accuracy: 1e-9)
        // Independent variance is the sum of squares.
        XCTAssertEqual(independent.deviation, (49.0 + 36 + 25).squareRoot(), accuracy: 1e-9)
        XCTAssertGreaterThan(correlated.deviation, independent.deviation)
        // Fully correlated is the sum of the deviations.
        let perfect = Statistics.combine(means: means, deviations: deviations, correlation: 1)
        XCTAssertEqual(perfect.deviation, 18, accuracy: 1e-6)
    }

    func testRemapClampsToDestination() {
        XCTAssertEqual(Statistics.remap(-5, from: 0...10, to: 0...1), 0, accuracy: 1e-9)
        XCTAssertEqual(Statistics.remap(15, from: 0...10, to: 0...1), 1, accuracy: 1e-9)
        XCTAssertEqual(Statistics.remap(5, from: 0...10, to: 0...1), 0.5, accuracy: 1e-9)
    }
}
