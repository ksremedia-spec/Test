import Foundation

/// Research for the demo league. The news already lives on each `PlayerContext`,
/// so this provider only needs to supply the invented weather that makes the
/// weather path visible without hitting the network.
struct DemoResearchProvider: ResearchProvider {
    let identifier = "demo-research"

    func news(for players: [Player], week: Int) async -> [NewsItem] { [] }

    func weather(for games: [ScheduledGame]) async -> [String: WeatherConditions] { [:] }
}
