import Foundation

/// Builds a self-contained fictional league.
///
/// Everything here is invented. The player names are fictional on purpose: making
/// up statistics and attaching them to real NFL players would be worse than
/// useless, because it would look authoritative while being fabricated. The teams
/// and stadiums are real because those are stable public facts.
///
/// The league is deliberately shaped so the app has something real to say: the
/// user's roster is strong at running back and genuinely thin at receiver, a
/// starter is questionable, a bench player has the better matchup, and the waiver
/// wire contains one player who just inherited a starting role.
enum DemoLeague {

    static let leagueID = "demo-league"
    static let userTeamID = "demo-team-1"
    static let source = "demo"

    /// The demo always presents an in-season week so the core weekly experience is
    /// what a new user sees first. The floor of week six matters: before that
    /// there is too little game history for trends, form charts and observed
    /// variance to mean anything, and a demo that shows those features empty
    /// misrepresents the product.
    static func currentWeek(now: Date = Date()) -> Int {
        let calendar = SeasonCalendar(now: now)
        return min(14, max(6, calendar.estimatedWeek()))
    }

    static func season(now: Date = Date()) -> Int {
        SeasonCalendar(now: now).season
    }

    static func league(now: Date = Date()) -> League {
        League(
            id: leagueID,
            platform: .demo,
            name: "Sunday Problems",
            season: season(now: now),
            teamCount: 12,
            scoring: .halfPPR,
            startingSlots: [
                .quarterback: 1,
                .runningBack: 2,
                .wideReceiver: 2,
                .tightEnd: 1,
                .flex: 1,
                .defense: 1,
                .kicker: 1
            ],
            benchSlots: 6,
            injuredReserveSlots: 1,
            waivers: .faab(budget: 100),
            waiverProcessingDay: 4,
            continuity: .redraft,
            playoffTeamCount: 6,
            playoffStartWeek: 15,
            regularSeasonWeeks: 14,
            tradeDeadlineWeek: 12,
            isPublic: false
        )
    }

    // MARK: - Player specifications

    /// A compact description of one fictional player, expanded into a full
    /// `PlayerContext` below.
    struct Spec {
        var name: String
        var position: Position
        var team: String
        var slot: RosterSlot
        /// Points per game the player has been averaging.
        var pointsPerGame: Double
        /// This week's projection, before the app adjusts it.
        var projection: Double
        var opponent: String
        var isHome: Bool
        var depthRank: Int
        var injury: InjuryReport = .healthy
        var snapShare: Double?
        var routeParticipation: Double?
        var targetShare: Double?
        var targets: Double?
        var carries: Double?
        var redZone: Double?
        var airYards: Double?
        var byeWeek: Int?
        var rostered: Double?
        var rosteredChange: Double?
        /// Set for the handful of players whose recent form is deliberately
        /// different from their season line, which is what makes trend analysis
        /// visible in the demo.
        var recentPointsPerGame: Double?
        var recentSnapShare: Double?
        var defenseRankAgainstPosition: Int?
    }

    // MARK: - The user's team

    static let userTeamSpecs: [Spec] = [
        Spec(name: "Miles Ashford", position: .quarterback, team: "BUF", slot: .quarterback,
             pointsPerGame: 21.4, projection: 21.8, opponent: "MIA", isHome: true, depthRank: 1,
             snapShare: 1.0, byeWeek: 12, rostered: 0.99, defenseRankAgainstPosition: 24),

        Spec(name: "Dorian Vance", position: .runningBack, team: "SF", slot: .runningBack,
             pointsPerGame: 19.8, projection: 20.4, opponent: "SEA", isHome: true, depthRank: 1,
             snapShare: 0.78, targetShare: 0.11, targets: 4.6, carries: 17.2, redZone: 3.4,
             byeWeek: 9, rostered: 1.0, defenseRankAgainstPosition: 21),

        Spec(name: "Cade Whitfield", position: .runningBack, team: "DET", slot: .runningBack,
             pointsPerGame: 16.1, projection: 15.2, opponent: "GB", isHome: false, depthRank: 1,
             injury: InjuryReport(status: .questionable, designation: "Ankle",
                                  practice: .limited, note: "Limited Wednesday and Thursday."),
             snapShare: 0.71, targetShare: 0.09, targets: 3.4, carries: 15.8, redZone: 2.8,
             byeWeek: 5, rostered: 0.99, defenseRankAgainstPosition: 11),

        Spec(name: "Rey Okafor", position: .wideReceiver, team: "CIN", slot: .wideReceiver,
             pointsPerGame: 11.2, projection: 11.6, opponent: "CLE", isHome: true, depthRank: 1,
             snapShare: 0.92, routeParticipation: 0.94, targetShare: 0.28, targets: 9.8,
             airYards: 118, byeWeek: 10, rostered: 1.0, defenseRankAgainstPosition: 9),

        Spec(name: "Trip Halloran", position: .wideReceiver, team: "CHI", slot: .wideReceiver,
             pointsPerGame: 5.9, projection: 6.1, opponent: "MIN", isHome: false, depthRank: 2,
             snapShare: 0.68, routeParticipation: 0.70, targetShare: 0.15, targets: 5.1,
             airYards: 62, byeWeek: 7, rostered: 0.61, recentPointsPerGame: 4.4,
             recentSnapShare: 0.58, defenseRankAgainstPosition: 6),

        Spec(name: "Emmett Reyes", position: .tightEnd, team: "KC", slot: .tightEnd,
             pointsPerGame: 10.7, projection: 11.1, opponent: "LV", isHome: true, depthRank: 1,
             snapShare: 0.84, routeParticipation: 0.81, targetShare: 0.19, targets: 6.4,
             airYards: 44, byeWeek: 10, rostered: 0.97, defenseRankAgainstPosition: 27),

        Spec(name: "Silas Boone", position: .wideReceiver, team: "PIT", slot: .flex,
             pointsPerGame: 5.2, projection: 5.4, opponent: "BAL", isHome: false, depthRank: 3,
             snapShare: 0.62, routeParticipation: 0.66, targetShare: 0.14, targets: 4.8,
             airYards: 71, byeWeek: 9, rostered: 0.44, defenseRankAgainstPosition: 4),

        Spec(name: "Denver Defense", position: .defense, team: "DEN", slot: .defense,
             pointsPerGame: 7.9, projection: 8.2, opponent: "NYJ", isHome: true, depthRank: 1,
             byeWeek: 14, rostered: 0.72),

        Spec(name: "Kaleb Ruiz", position: .kicker, team: "DAL", slot: .kicker,
             pointsPerGame: 8.4, projection: 8.1, opponent: "PHI", isHome: true, depthRank: 1,
             byeWeek: 7, rostered: 0.68),

        // Bench
        Spec(name: "Jonah Whitaker", position: .wideReceiver, team: "TB", slot: .bench,
             pointsPerGame: 10.4, projection: 12.3, opponent: "CAR", isHome: true, depthRank: 2,
             snapShare: 0.81, routeParticipation: 0.86, targetShare: 0.21, targets: 7.2,
             airYards: 96, byeWeek: 11, rostered: 0.58, recentPointsPerGame: 13.8,
             recentSnapShare: 0.91, defenseRankAgainstPosition: 30),

        Spec(name: "Amari Lindgren", position: .runningBack, team: "NYG", slot: .bench,
             pointsPerGame: 7.6, projection: 7.9, opponent: "WSH", isHome: false, depthRank: 2,
             snapShare: 0.38, targetShare: 0.08, targets: 2.9, carries: 7.4, redZone: 1.1,
             byeWeek: 11, rostered: 0.41, defenseRankAgainstPosition: 17),

        Spec(name: "Beau Castellan", position: .tightEnd, team: "ATL", slot: .bench,
             pointsPerGame: 6.2, projection: 6.0, opponent: "NO", isHome: true, depthRank: 1,
             snapShare: 0.66, routeParticipation: 0.61, targetShare: 0.12, targets: 3.8,
             byeWeek: 12, rostered: 0.28, defenseRankAgainstPosition: 15),

        Spec(name: "Nico Ferrante", position: .quarterback, team: "LAC", slot: .bench,
             pointsPerGame: 16.2, projection: 15.4, opponent: "KC", isHome: false, depthRank: 1,
             snapShare: 1.0, byeWeek: 5, rostered: 0.55, defenseRankAgainstPosition: 8),

        Spec(name: "Grant Mosley", position: .wideReceiver, team: "TEN", slot: .bench,
             pointsPerGame: 3.8, projection: 3.6, opponent: "IND", isHome: true, depthRank: 3,
             snapShare: 0.44, routeParticipation: 0.48, targetShare: 0.09, targets: 3.1,
             byeWeek: 5, rostered: 0.12, recentPointsPerGame: 2.9, recentSnapShare: 0.36,
             defenseRankAgainstPosition: 19),

        Spec(name: "Everett Sloan", position: .runningBack, team: "LAR", slot: .bench,
             pointsPerGame: 6.8, projection: 6.4, opponent: "ARI", isHome: true, depthRank: 3,
             snapShare: 0.29, carries: 6.1, byeWeek: 8, rostered: 0.19,
             defenseRankAgainstPosition: 23)
    ]

    // MARK: - The opponent

    static let opponentSpecs: [Spec] = [
        Spec(name: "Wes Kaminski", position: .quarterback, team: "PHI", slot: .quarterback,
             pointsPerGame: 22.6, projection: 22.1, opponent: "DAL", isHome: false, depthRank: 1,
             snapShare: 1.0, byeWeek: 8, rostered: 1.0, defenseRankAgainstPosition: 14),

        Spec(name: "Rasheed Colvin", position: .runningBack, team: "JAX", slot: .runningBack,
             pointsPerGame: 12.4, projection: 12.8, opponent: "HOU", isHome: true, depthRank: 1,
             snapShare: 0.64, targets: 3.1, carries: 14.2, byeWeek: 9, rostered: 0.94,
             defenseRankAgainstPosition: 12),

        Spec(name: "Tobias Vance", position: .runningBack, team: "NE", slot: .runningBack,
             pointsPerGame: 9.8, projection: 9.2, opponent: "BUF", isHome: false, depthRank: 2,
             snapShare: 0.48, carries: 10.6, byeWeek: 14, rostered: 0.66,
             defenseRankAgainstPosition: 5),

        Spec(name: "Xavier Dumont", position: .wideReceiver, team: "MIN", slot: .wideReceiver,
             pointsPerGame: 18.2, projection: 18.9, opponent: "CHI", isHome: true, depthRank: 1,
             snapShare: 0.95, routeParticipation: 0.96, targetShare: 0.31, targets: 11.2,
             airYards: 142, byeWeek: 9, rostered: 1.0, defenseRankAgainstPosition: 26),

        Spec(name: "Ronan Beck", position: .wideReceiver, team: "MIA", slot: .wideReceiver,
             pointsPerGame: 14.6, projection: 14.9, opponent: "BUF", isHome: false, depthRank: 1,
             snapShare: 0.89, routeParticipation: 0.91, targetShare: 0.26, targets: 9.1,
             airYards: 131, byeWeek: 12, rostered: 0.99, defenseRankAgainstPosition: 18),

        Spec(name: "Marcus Thibault", position: .tightEnd, team: "BAL", slot: .tightEnd,
             pointsPerGame: 9.4, projection: 9.8, opponent: "PIT", isHome: true, depthRank: 1,
             snapShare: 0.79, routeParticipation: 0.74, targetShare: 0.17, targets: 5.6,
             byeWeek: 10, rostered: 0.88, defenseRankAgainstPosition: 13),

        Spec(name: "Kyrie Alston", position: .wideReceiver, team: "SEA", slot: .flex,
             pointsPerGame: 13.1, projection: 13.6, opponent: "SF", isHome: false, depthRank: 2,
             snapShare: 0.86, routeParticipation: 0.88, targetShare: 0.23, targets: 8.1,
             airYards: 104, byeWeek: 8, rostered: 0.93, defenseRankAgainstPosition: 10),

        Spec(name: "Houston Defense", position: .defense, team: "HOU", slot: .defense,
             pointsPerGame: 8.6, projection: 7.4, opponent: "JAX", isHome: false, depthRank: 1,
             byeWeek: 13, rostered: 0.81),

        Spec(name: "Pavel Novak", position: .kicker, team: "GB", slot: .kicker,
             pointsPerGame: 8.9, projection: 8.8, opponent: "DET", isHome: true, depthRank: 1,
             byeWeek: 10, rostered: 0.74),

        Spec(name: "Isaiah Trammell", position: .wideReceiver, team: "LV", slot: .bench,
             pointsPerGame: 9.2, projection: 9.0, opponent: "KC", isHome: false, depthRank: 2,
             snapShare: 0.72, routeParticipation: 0.76, targetShare: 0.18, targets: 6.2,
             byeWeek: 10, rostered: 0.52, defenseRankAgainstPosition: 7),

        Spec(name: "Dane Kirkpatrick", position: .runningBack, team: "CLE", slot: .bench,
             pointsPerGame: 8.1, projection: 8.4, opponent: "CIN", isHome: false, depthRank: 2,
             snapShare: 0.41, carries: 8.8, byeWeek: 10, rostered: 0.37,
             defenseRankAgainstPosition: 22),

        Spec(name: "Terrell Boisvert", position: .tightEnd, team: "DEN", slot: .bench,
             pointsPerGame: 5.8, projection: 5.6, opponent: "NYJ", isHome: true, depthRank: 1,
             snapShare: 0.63, targetShare: 0.11, targets: 3.4, byeWeek: 14, rostered: 0.21,
             defenseRankAgainstPosition: 3),

        Spec(name: "Auden Fisk", position: .quarterback, team: "IND", slot: .bench,
             pointsPerGame: 15.1, projection: 14.6, opponent: "TEN", isHome: false, depthRank: 1,
             snapShare: 1.0, byeWeek: 14, rostered: 0.48, defenseRankAgainstPosition: 20),

        Spec(name: "Colton Reaves", position: .wideReceiver, team: "NYJ", slot: .bench,
             pointsPerGame: 7.4, projection: 7.1, opponent: "DEN", isHome: false, depthRank: 2,
             snapShare: 0.61, routeParticipation: 0.64, targetShare: 0.13, targets: 4.4,
             byeWeek: 12, rostered: 0.24, defenseRankAgainstPosition: 2),

        Spec(name: "Judah Mensah", position: .runningBack, team: "TB", slot: .bench,
             pointsPerGame: 6.4, projection: 6.1, opponent: "CAR", isHome: true, depthRank: 3,
             snapShare: 0.27, carries: 5.4, byeWeek: 11, rostered: 0.16,
             defenseRankAgainstPosition: 28)
    ]

    // MARK: - Waiver pool

    static let waiverSpecs: [Spec] = [
        // The headline pickup: promoted into a full-time role this week.
        Spec(name: "Deon Ridley", position: .wideReceiver, team: "HOU", slot: .bench,
             pointsPerGame: 7.1, projection: 11.4, opponent: "JAX", isHome: false, depthRank: 1,
             snapShare: 0.83, routeParticipation: 0.88, targetShare: 0.24, targets: 8.4,
             airYards: 109, byeWeek: 13, rostered: 0.34, rosteredChange: 22.0,
             recentPointsPerGame: 14.2, recentSnapShare: 0.88, defenseRankAgainstPosition: 25),

        Spec(name: "Marquis Feld", position: .runningBack, team: "NO", slot: .bench,
             pointsPerGame: 5.9, projection: 11.8, opponent: "ATL", isHome: false, depthRank: 1,
             snapShare: 0.68, carries: 13.4, redZone: 2.2, byeWeek: 12, rostered: 0.28,
             rosteredChange: 19.0, recentPointsPerGame: 12.9, recentSnapShare: 0.71,
             defenseRankAgainstPosition: 20),

        Spec(name: "Zane Hollis", position: .wideReceiver, team: "ARI", slot: .bench,
             pointsPerGame: 8.0, projection: 8.2, opponent: "LAR", isHome: false, depthRank: 2,
             snapShare: 0.74, routeParticipation: 0.79, targetShare: 0.19, targets: 6.6,
             airYards: 88, byeWeek: 11, rostered: 0.39, rosteredChange: 6.0,
             defenseRankAgainstPosition: 16),

        Spec(name: "Bo Lindqvist", position: .tightEnd, team: "NYG", slot: .bench,
             pointsPerGame: 8.4, projection: 8.9, opponent: "WSH", isHome: false, depthRank: 1,
             snapShare: 0.77, routeParticipation: 0.72, targetShare: 0.18, targets: 5.9,
             byeWeek: 11, rostered: 0.31, rosteredChange: 8.0, recentPointsPerGame: 9.6,
             defenseRankAgainstPosition: 29),

        Spec(name: "Rocco Delaney", position: .quarterback, team: "CAR", slot: .bench,
             pointsPerGame: 14.2, projection: 16.8, opponent: "TB", isHome: false, depthRank: 1,
             snapShare: 1.0, byeWeek: 11, rostered: 0.22, rosteredChange: 11.0,
             defenseRankAgainstPosition: 31),

        Spec(name: "Junior Alcantara", position: .runningBack, team: "WSH", slot: .bench,
             pointsPerGame: 6.2, projection: 7.4, opponent: "NYG", isHome: true, depthRank: 2,
             snapShare: 0.42, carries: 8.1, byeWeek: 14, rostered: 0.26, rosteredChange: 3.0,
             defenseRankAgainstPosition: 24),

        Spec(name: "Tariq Beaumont", position: .wideReceiver, team: "CLE", slot: .bench,
             pointsPerGame: 6.1, projection: 6.4, opponent: "CIN", isHome: false, depthRank: 3,
             snapShare: 0.56, routeParticipation: 0.59, targetShare: 0.12, targets: 4.1,
             byeWeek: 10, rostered: 0.18, rosteredChange: 2.0, defenseRankAgainstPosition: 22),

        Spec(name: "Seattle Defense", position: .defense, team: "SEA", slot: .bench,
             pointsPerGame: 7.2, projection: 6.1, opponent: "SF", isHome: false, depthRank: 1,
             byeWeek: 8, rostered: 0.35, rosteredChange: -4.0),

        Spec(name: "Lorenzo Pike", position: .tightEnd, team: "LV", slot: .bench,
             pointsPerGame: 5.1, projection: 5.4, opponent: "KC", isHome: false, depthRank: 1,
             snapShare: 0.58, targetShare: 0.10, targets: 3.2, byeWeek: 10, rostered: 0.14,
             defenseRankAgainstPosition: 11),

        Spec(name: "Cyrus Nakamura", position: .kicker, team: "SF", slot: .bench,
             pointsPerGame: 8.8, projection: 9.1, opponent: "SEA", isHome: true, depthRank: 1,
             byeWeek: 9, rostered: 0.44, rosteredChange: 5.0),

        Spec(name: "Ellis Vandenberg", position: .wideReceiver, team: "JAX", slot: .bench,
             pointsPerGame: 4.5, projection: 4.8, opponent: "HOU", isHome: true, depthRank: 3,
             snapShare: 0.38, routeParticipation: 0.42, targetShare: 0.08, targets: 2.8,
             byeWeek: 9, rostered: 0.08, defenseRankAgainstPosition: 21),

        Spec(name: "Dashiell Crowe", position: .runningBack, team: "PIT", slot: .bench,
             pointsPerGame: 4.4, projection: 4.8, opponent: "BAL", isHome: false, depthRank: 3,
             snapShare: 0.22, carries: 4.6, byeWeek: 9, rostered: 0.06,
             defenseRankAgainstPosition: 6)
    ]
}
