import Foundation
import OSLog

/// Central logging. Never logs credentials, cookies or tokens — the networking
/// layer redacts those before they reach here.
enum AppLog {
    private static let subsystem = "com.gameplan.fantasy"

    static let network = Logger(subsystem: subsystem, category: "network")
    static let analysis = Logger(subsystem: subsystem, category: "analysis")
    static let persistence = Logger(subsystem: subsystem, category: "persistence")
    static let ui = Logger(subsystem: subsystem, category: "ui")
    static let notifications = Logger(subsystem: subsystem, category: "notifications")
}
