import Foundation

/// Writes the week's prose from the evidence pack, deterministically.
///
/// This is the default narrator and it is not a placeholder. It runs instantly,
/// costs nothing, works offline, and cannot hallucinate — every sentence is
/// assembled from a value that is already in the pack. The remote narrator exists
/// to make the writing better, not to make the app work.
struct TemplateNarrator: NarrationProvider {
    let identifier = "on-device"
    let isRemote = false

    func narrate(_ pack: EvidencePack) async throws -> Narration {
        Narration(
            headline: headline(for: pack),
            positioning: positioning(for: pack),
            moveSummaries: [:],
            restingEasy: restingEasy(for: pack)
        )
    }

    // MARK: - Headline

    private func headline(for pack: EvidencePack) -> String {
        let mustDo = pack.proposedMoves.filter { $0.priority == RecommendationPriority.mustDo.rawValue }
        let probability = Int((pack.matchup.winProbability * 100).rounded())

        if pack.matchup.opponentName == nil {
            return "No opponent this week — set your best lineup and bank the points."
        }

        if !mustDo.isEmpty {
            if let weakness = weakestPosition(in: pack) {
                return mustDo.count == 1
                    ? "One move to make, and \(weakness.position) is the reason."
                    : "\(mustDo.count) moves to make, and \(weakness.position) is the theme."
            }
            return mustDo.count == 1
                ? "One move to make before kickoff."
                : "\(mustDo.count) moves to make before kickoff."
        }

        switch probability {
        case 72...: return "You're in control this week."
        case 58..<72: return "You're favored, and your lineup is already set right."
        case 42..<58: return "This one's a coin flip."
        case 28..<42: return "You're an underdog — you'll need a big week from someone."
        default: return "You're a heavy underdog. Play for the ceiling."
        }
    }

    /// The position group most worth naming.
    ///
    /// Kickers and defenses are skipped for the same reason the engine skips them
    /// when picking a weakness: they are streamed weekly and naming one as the
    /// story of the week would be accurate and useless.
    private func weakestPosition(in pack: EvidencePack) -> EvidencePack.PositionFacts? {
        pack.positionAssessments
            .filter { $0.pointsAboveReplacement < 0 && $0.position != "K" && $0.position != "DST" }
            .min { $0.pointsAboveReplacement < $1.pointsAboveReplacement }
    }

    /// "QB, RB and TE" — an Oxford-free list that reads like a person wrote it.
    private func list(_ items: [String]) -> String {
        switch items.count {
        case 0: return ""
        case 1: return items[0]
        case 2: return "\(items[0]) and \(items[1])"
        default: return items.dropLast().joined(separator: ", ") + " and " + (items.last ?? "")
        }
    }

    // MARK: - Positioning

    private func positioning(for pack: EvidencePack) -> String {
        var sentences: [String] = []
        let matchup = pack.matchup
        let probability = Int((matchup.winProbability * 100).rounded())

        if let opponent = matchup.opponentName {
            sentences.append(String(
                format: "Gameplan projects %.1f for you against %.1f for %@ — about a %d%% chance to win.",
                matchup.projectedPoints, matchup.projectedOpponentPoints, opponent, probability
            ))
        } else {
            sentences.append(String(format: "Gameplan projects %.1f points for your lineup.", matchup.projectedPoints))
        }

        // Where the matchup is actually won or lost.
        let sorted = matchup.positionMargins.sorted { $0.value > $1.value }
        if let best = sorted.first, let worst = sorted.last, best.key != worst.key {
            if best.value > 2 && worst.value < -2 {
                sentences.append(String(
                    format: "You have a clear edge at %@ (%+.1f points) and a real problem at %@ (%+.1f).",
                    best.key, best.value, worst.key, worst.value
                ))
            } else if worst.value < -4 {
                sentences.append(String(format: "%@ is where this gets away from you (%+.1f points).", worst.key, worst.value))
            } else if best.value > 4 {
                sentences.append(String(format: "%@ is carrying you this week (%+.1f points).", best.key, best.value))
            }
        }

        sentences.append(strategyLine(for: matchup.posture))
        return sentences.joined(separator: " ")
    }

    private func strategyLine(for posture: String) -> String {
        guard let value = WeeklyPosture(rawValue: posture) else {
            return "Play the highest expected points."
        }
        return value.strategyStatement
    }

    // MARK: - What can wait

    private func restingEasy(for pack: EvidencePack) -> String {
        let strengths = pack.positionAssessments
            .filter { $0.pointsAboveReplacement > 3 }
            .map(\.position)
        let watching = pack.watchItems.count

        var sentences: [String] = []
        if strengths.isEmpty {
            sentences.append("Nothing else needs action right now.")
        } else if strengths.count == 1 {
            sentences.append("Leave \(strengths[0]) alone — it's the strongest part of your roster.")
        } else {
            sentences.append("Leave \(list(Array(strengths.prefix(3)))) alone — those are settled.")
        }

        if watching > 0 {
            sentences.append(watching == 1
                ? "Check back before kickoff for the one situation on your watch list."
                : "Check back before kickoff for the \(watching) situations on your watch list.")
        } else {
            sentences.append("There's nothing outstanding to check before kickoff.")
        }

        return sentences.joined(separator: " ")
    }
}
