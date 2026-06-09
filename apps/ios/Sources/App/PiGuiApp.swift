import SwiftUI

@main
struct PiGuiApp: App {
    @StateObject private var app = AppState()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(app)
                .tint(.indigo)
        }
    }
}

struct RootView: View {
    @EnvironmentObject var app: AppState

    var body: some View {
        if app.isPaired, let api = app.api, let bus = app.bus {
            BrowserView(api: api, bus: bus)
        } else {
            PairingView()
        }
    }
}
