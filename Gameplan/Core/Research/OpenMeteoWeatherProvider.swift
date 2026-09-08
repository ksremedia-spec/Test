import Foundation

/// Game-day weather from Open-Meteo.
///
/// Open-Meteo is used because it is free for non-commercial use, needs no API key
/// and therefore no secret in the app, and publishes a documented, stable API —
/// which is exactly the bar the product asks for before depending on a source.
/// If it is unreachable the app simply proceeds without weather and says so in
/// the data-quality note.
struct OpenMeteoWeatherProvider: ResearchProvider {
    let identifier = "open-meteo"

    private let session: URLSession

    init(session: URLSession = .shared) {
        self.session = session
    }

    func news(for players: [Player], week: Int) async -> [NewsItem] { [] }

    func weather(for games: [ScheduledGame]) async -> [String: WeatherConditions] {
        await withTaskGroup(of: (String, WeatherConditions?).self) { group in
            for game in games {
                let stadium = NFLTeam.team(abbreviation: game.homeTeamAbbreviation)
                // Indoor venues and unknown teams are not worth a request.
                guard !stadium.isIndoor, stadium.latitude != 0 else { continue }
                group.addTask {
                    (game.homeTeamAbbreviation, await self.forecast(for: stadium, kickoff: game.kickoff))
                }
            }

            var results: [String: WeatherConditions] = [:]
            for await (team, conditions) in group {
                if let conditions { results[team] = conditions }
            }
            return results
        }
    }

    private func forecast(for stadium: NFLTeam, kickoff: Date?) async -> WeatherConditions? {
        guard let kickoff, kickoff.timeIntervalSinceNow < 15 * 24 * 3600 else { return nil }
        guard let url = url(for: stadium) else { return nil }

        do {
            let (data, response) = try await session.data(from: url)
            guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                return nil
            }
            let payload = try JSONDecoder().decode(Forecast.self, from: data)
            return payload.conditions(nearest: kickoff)
        } catch {
            AppLog.network.debug("Weather lookup failed for \(stadium.abbreviation, privacy: .public)")
            return nil
        }
    }

    private func url(for stadium: NFLTeam) -> URL? {
        var components = URLComponents()
        components.scheme = "https"
        components.host = "api.open-meteo.com"
        components.path = "/v1/forecast"
        components.queryItems = [
            URLQueryItem(name: "latitude", value: String(stadium.latitude)),
            URLQueryItem(name: "longitude", value: String(stadium.longitude)),
            URLQueryItem(name: "hourly", value: "temperature_2m,precipitation_probability,wind_speed_10m"),
            URLQueryItem(name: "temperature_unit", value: "fahrenheit"),
            URLQueryItem(name: "wind_speed_unit", value: "mph"),
            URLQueryItem(name: "timeformat", value: "unixtime"),
            URLQueryItem(name: "timezone", value: "UTC"),
            URLQueryItem(name: "forecast_days", value: "16")
        ]
        return components.url
    }

    // MARK: - Wire format

    private struct Forecast: Decodable {
        var hourly: Hourly?

        struct Hourly: Decodable {
            var time: [Double]?
            var temperature_2m: [Double?]?
            var precipitation_probability: [Double?]?
            var wind_speed_10m: [Double?]?
        }

        /// Picks the forecast hour closest to kickoff.
        func conditions(nearest date: Date) -> WeatherConditions? {
            guard let times = hourly?.time, !times.isEmpty else { return nil }
            let target = date.timeIntervalSince1970

            var bestIndex = 0
            var bestDistance = Double.greatestFiniteMagnitude
            for (index, time) in times.enumerated() {
                let distance = abs(time - target)
                if distance < bestDistance {
                    bestDistance = distance
                    bestIndex = index
                }
            }
            // More than three hours away is not a kickoff forecast.
            guard bestDistance <= 3 * 3600 else { return nil }

            let temperature = value(hourly?.temperature_2m, at: bestIndex)
            let wind = value(hourly?.wind_speed_10m, at: bestIndex)
            let precipitation = value(hourly?.precipitation_probability, at: bestIndex).map { $0 / 100 }

            guard temperature != nil || wind != nil || precipitation != nil else { return nil }
            return WeatherConditions(
                temperatureFahrenheit: temperature,
                windMilesPerHour: wind,
                precipitationChance: precipitation,
                summary: nil
            )
        }

        private func value(_ array: [Double?]?, at index: Int) -> Double? {
            guard let array, array.indices.contains(index) else { return nil }
            return array[index]
        }
    }
}
