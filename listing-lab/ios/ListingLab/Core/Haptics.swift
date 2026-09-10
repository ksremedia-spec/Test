import UIKit

/// The small taps that make moments land: one when a job starts, a firmer
/// one when a photo is ready. Nothing on the simulator, which has no motor.
@MainActor
enum Haptics {
    static func tap() { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
    static func success() { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    static func warning() { UINotificationFeedbackGenerator().notificationOccurred(.warning) }
}
