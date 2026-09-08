import SwiftUI

@main
struct GameplanApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .tint(Theme.Palette.accent)
        }
    }
}
