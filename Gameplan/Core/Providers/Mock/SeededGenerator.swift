import Foundation

/// A small deterministic pseudo-random generator.
///
/// The demo league must look the same every launch — otherwise caching, "what
/// changed since last time" and the user's trust in the numbers all break. A
/// seeded generator gives realistic-looking variation that is nonetheless stable.
struct SeededGenerator: RandomNumberGenerator {
    private var state: UInt64

    init(seed: UInt64) {
        // Avoid the degenerate all-zero state.
        self.state = seed == 0 ? 0x9E3779B97F4A7C15 : seed
    }

    mutating func next() -> UInt64 {
        // xorshift64*
        state ^= state >> 12
        state ^= state << 25
        state ^= state >> 27
        return state &* 2685821657736338717
    }

    /// Uniform double in 0..<1.
    mutating func nextUnit() -> Double {
        Double(next() >> 11) * (1.0 / 9007199254740992.0)
    }

    mutating func nextDouble(in range: ClosedRange<Double>) -> Double {
        range.lowerBound + nextUnit() * (range.upperBound - range.lowerBound)
    }

    /// Approximately standard-normal via the sum of twelve uniforms.
    mutating func nextGaussian() -> Double {
        var total = 0.0
        for _ in 0..<12 { total += nextUnit() }
        return total - 6.0
    }
}
