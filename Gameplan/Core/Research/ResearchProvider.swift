import Foundation

/// Supplementary research that the fantasy platform does not supply: news,
/// weather, and betting context.
///
/// Every method is allowed to return nothing. The engine treats missing research
/// as "unknown" and says so, rather than filling the gap with a guess.
protocol ResearchProvider: Sendable {
    var identifier: String { get }

    /// Recent news for the given players.
    func news(for players: [Player], week: Int) async -> [NewsItem]

    /// Kickoff weather for a set of games, keyed by the home team's abbreviation.
    func weather(for games: [ScheduledGame]) async -> [String: WeatherConditions]

    /// Betting context keyed by home team abbreviation, when a legal source is
    /// configured. Returns empty when it is not.
    func bettingContext(for games: [ScheduledGame]) async -> [String: BettingContext]
}

extension ResearchProvider {
    func bettingContext(for games: [ScheduledGame]) async -> [String: BettingContext] { [:] }
}

/// A single NFL game that some player in the user's world is involved in.
struct ScheduledGame: Hashable, Sendable {
    var homeTeamAbbreviation: String
    var awayTeamAbbreviation: String
    var kickoff: Date?
    var week: Int

    var id: String { "\(week)-\(awayTeamAbbreviation)-\(homeTeamAbbreviation)" }
}

/// A research provider that supplies nothing. Used when the user has opted out of
/// network research, and as the base for composition.
struct EmptyResearchProvider: ResearchProvider {
    let identifier = "none"
    func news(for players: [Player], week: Int) async -> [NewsItem] { [] }
    func weather(for games: [ScheduledGame]) async -> [String: WeatherConditions] { [:] }
}

/// Runs several providers and merges their results, so a weather source and a
/// news source can be combined without either knowing about the other.
struct CompositeResearchProvider: ResearchProvider {
    let identifier = "composite"
    var providers: [ResearchProvider]

    init(_ providers: [ResearchProvider]) {
        self.providers = providers
    }

    func news(for players: [Player], week: Int) async -> [NewsItem] {
        var seen = Set<String>()
        var merged: [NewsItem] = []
        for provider in providers {
            for item in await provider.news(for: players, week: week) where !seen.contains(item.id) {
                seen.insert(item.id)
                merged.append(item)
            }
        }
        return merged.sorted { $0.publishedAt > $1.publishedAt }
    }

    func weather(for games: [ScheduledGame]) async -> [String: WeatherConditions] {
        var merged: [String: WeatherConditions] = [:]
        for provider in providers {
            for (key, value) in await provider.weather(for: games) where merged[key] == nil {
                merged[key] = value
            }
        }
        return merged
    }

    func bettingContext(for games: [ScheduledGame]) async -> [String: BettingContext] {
        var merged: [String: BettingContext] = [:]
        for provider in providers {
            for (key, value) in await provider.bettingContext(for: games) where merged[key] == nil {
                merged[key] = value
            }
        }
        return merged
    }
}
