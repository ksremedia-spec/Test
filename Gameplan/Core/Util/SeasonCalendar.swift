import Foundation

/// Works out where the NFL calendar is and when this week's deadlines fall.
///
/// The NFL schedule is not fully deterministic, so anything the fantasy provider
/// tells us (current week, first kickoff) always wins. This type exists to give
/// sensible answers when the provider is silent, and to turn a week number into
/// the human deadlines the user actually cares about.
struct SeasonCalendar: Sendable {
    var calendar: Calendar
    var now: Date

    init(calendar: Calendar = .autoupdatingCurrent, now: Date = Date()) {
        var calendar = calendar
        calendar.firstWeekday = 1
        self.calendar = calendar
        self.now = now
    }

    /// The season a date belongs to. The 2025 season runs from September 2025
    /// into February 2026, so January and February belong to the previous season.
    var season: Int {
        let components = calendar.dateComponents([.year, .month], from: now)
        let year = components.year ?? 2025
        let month = components.month ?? 9
        return month <= 2 ? year - 1 : year
    }

    /// Week 1 traditionally kicks off on the Thursday after Labor Day. This finds
    /// that Thursday for the given season.
    func week1Kickoff(season: Int) -> Date? {
        var septemberFirst = DateComponents()
        septemberFirst.year = season
        septemberFirst.month = 9
        septemberFirst.day = 1
        guard let start = calendar.date(from: septemberFirst) else { return nil }

        // Labor Day is the first Monday in September.
        var laborDay = start
        for offset in 0..<7 {
            guard let candidate = calendar.date(byAdding: .day, value: offset, to: start) else { continue }
            if calendar.component(.weekday, from: candidate) == 2 {
                laborDay = candidate
                break
            }
        }
        // Kickoff Thursday is three days later, at 8:20 PM Eastern.
        guard let thursday = calendar.date(byAdding: .day, value: 3, to: laborDay) else { return nil }
        return calendar.date(bySettingHour: 20, minute: 20, second: 0, of: thursday)
    }

    /// Best-effort current week, 1...18. Used only when the provider does not
    /// report one.
    func estimatedWeek(season: Int? = nil) -> Int {
        let targetSeason = season ?? self.season
        guard let kickoff = week1Kickoff(season: targetSeason) else { return 1 }
        let elapsed = now.timeIntervalSince(kickoff)
        guard elapsed > 0 else { return 1 }
        let weeks = Int(elapsed / (7 * 24 * 3600)) + 1
        return min(18, max(1, weeks))
    }

    func phase(week: Int, league: League) -> SeasonPhase {
        guard let kickoff = week1Kickoff(season: league.season) else { return .regularSeason }
        if now < kickoff.addingTimeInterval(-14 * 24 * 3600) { return .offseason }
        if now < kickoff { return .preseason }
        if week > 18 { return .offseason }
        return league.isPlayoffWeek(week) ? .fantasyPlayoffs : .regularSeason
    }

    /// The Sunday 1:00 PM Eastern kickoff for the current week — the practical
    /// lineup deadline for most managers.
    func sundayKickoff(after reference: Date? = nil) -> Date? {
        let start = reference ?? now
        var components = DateComponents()
        components.weekday = 1 // Sunday
        components.hour = 13
        components.minute = 0
        guard let easternZone = TimeZone(identifier: "America/New_York") else { return nil }
        var easternCalendar = calendar
        easternCalendar.timeZone = easternZone
        return easternCalendar.nextDate(after: start, matching: components, matchingPolicy: .nextTime)
    }

    /// Next occurrence of the league's waiver processing day, early morning.
    /// `weekday` uses `Calendar`'s convention where Sunday is 1.
    func nextWaiverProcessing(weekday: Int?) -> Date? {
        guard let weekday, (1...7).contains(weekday) else { return nil }
        var components = DateComponents()
        components.weekday = weekday
        components.hour = 3
        components.minute = 0
        guard let easternZone = TimeZone(identifier: "America/New_York") else { return nil }
        var easternCalendar = calendar
        easternCalendar.timeZone = easternZone
        return easternCalendar.nextDate(after: now, matching: components, matchingPolicy: .nextTime)
    }

    /// "Sunday 1:00 PM" style label for a deadline.
    static func deadlineDescription(for date: Date, calendar: Calendar = .autoupdatingCurrent) -> String {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.locale = .autoupdatingCurrent
        formatter.setLocalizedDateFormatFromTemplate("EEEE h:mm a")
        return formatter.string(from: date)
    }
}
