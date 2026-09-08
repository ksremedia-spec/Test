import Foundation
import CryptoKit

/// Produces a stable hash of the inputs an analysis depends on.
///
/// The app re-runs analysis only when this changes. That keeps the deterministic
/// engine cheap to call and, more importantly, means the language model is never
/// invoked just because the user opened the same screen twice.
enum Fingerprint {

    static func make(_ components: [String]) -> String {
        let joined = components.joined(separator: "|")
        let digest = SHA256.hash(data: Data(joined.utf8))
        return digest.compactMap { String(format: "%02x", $0) }.joined().prefix(20).description
    }

    /// Everything that should invalidate a cached game plan: the week, the league
    /// rules, both rosters, each player's slot, health and projection.
    static func forAnalysis(
        league: League,
        matchup: Matchup,
        waiverPool: [PlayerContext]
    ) -> String {
        var parts: [String] = [
            league.id,
            String(league.season),
            String(matchup.week),
            league.scoring.formatName,
            String(league.teamCount),
            league.lineupSlots.map(\.rawValue).sorted().joined(separator: ",")
        ]

        parts.append(contentsOf: rosterComponents(for: matchup.userTeam))
        if let opponent = matchup.opponentTeam {
            parts.append(contentsOf: rosterComponents(for: opponent))
        }

        // Only the waiver names and health matter for cache purposes; ordering is
        // normalised so an unstable provider ordering does not thrash the cache.
        let waiverParts = waiverPool
            .map { "\($0.id.rawValue):\($0.player.injury.status.rawValue):\(round(($0.providerProjectedPoints ?? 0) * 10))" }
            .sorted()
        parts.append(contentsOf: waiverParts)

        return make(parts)
    }

    private static func rosterComponents(for team: FantasyTeam) -> [String] {
        team.roster
            .map { entry in
                let projection = entry.context.providerProjectedPoints.map { String(round($0 * 10)) } ?? "-"
                let practice = entry.context.player.injury.practice?.rawValue ?? "-"
                return [
                    team.id,
                    entry.id.rawValue,
                    entry.slot.rawValue,
                    entry.player.injury.status.rawValue,
                    practice,
                    projection
                ].joined(separator: ":")
            }
            .sorted()
    }
}
