import Foundation

/// Checks generated prose against the evidence it was given.
///
/// A language model asked to explain fantasy advice will, unprompted, reach for
/// a plausible statistic it was never handed. This validator is the structural
/// answer to that: it extracts every number from the generated text and rejects
/// the response if any of them is absent from the evidence pack.
///
/// It is deliberately strict about numbers and silent about everything else.
/// Prose quality is a matter of taste; a fabricated target share is not.
struct NarrationValidator {
    /// Numbers this close to an evidence value count as a match, which allows for
    /// sensible rounding in the prose.
    var tolerance: Double = 0.55

    /// Values that appear so often in ordinary English that treating them as
    /// claims would reject every valid response.
    private let permitted: Set<Double> = [0, 1, 2, 3, 4, 5, 100]

    struct Result {
        var isAcceptable: Bool
        var unsupportedValues: [Double]
        var reason: String?
    }

    func validate(_ narration: Narration, against pack: EvidencePack) -> Result {
        let text = ([narration.headline, narration.positioning, narration.restingEasy]
            + narration.moveSummaries.values).joined(separator: " ")

        let claimed = numbers(in: text)
        let supported = pack.allNumericValues

        var unsupported: [Double] = []
        for value in claimed {
            if permitted.contains(value) { continue }
            // Week numbers, team counts and the like are already in the pack, so
            // anything left over is a figure the model produced on its own.
            let isSupported = supported.contains { abs($0 - value) <= tolerance }
            if !isSupported { unsupported.append(value) }
        }

        guard unsupported.isEmpty else {
            let list = unsupported.map { String(format: "%g", $0) }.joined(separator: ", ")
            return Result(
                isAcceptable: false,
                unsupportedValues: unsupported,
                reason: "Contains figures not present in the evidence: \(list)."
            )
        }

        guard !narration.headline.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return Result(isAcceptable: false, unsupportedValues: [], reason: "Empty headline.")
        }

        return Result(isAcceptable: true, unsupportedValues: [], reason: nil)
    }

    /// Pulls numeric tokens out of prose, ignoring ordinals attached to words and
    /// currency symbols.
    func numbers(in text: String) -> [Double] {
        var results: [Double] = []
        var current = ""

        func flush() {
            defer { current = "" }
            guard !current.isEmpty else { return }
            let trimmed = current.trimmingCharacters(in: CharacterSet(charactersIn: "."))
            guard let value = Double(trimmed) else { return }
            results.append(value)
        }

        for character in text {
            if character.isNumber || (character == "." && !current.isEmpty) {
                current.append(character)
            } else {
                flush()
            }
        }
        flush()
        return results
    }
}
