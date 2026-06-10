import SwiftUI

// Main shell: sidebar (browse) + tab strip + active session + optional info panel.
struct ContentView: View {
    @EnvironmentObject var model: AppModel
    @State private var showInfo = false
    // Observe theme/language so changes in Settings apply live to the whole app.
    @AppStorage(AppSettingsKeys.themeMode) private var themeMode = "auto"
    @AppStorage(AppSettingsKeys.trueDark) private var trueDark = false
    @AppStorage(AppSettingsKeys.lang) private var lang = "en"

    private var colorScheme: ColorScheme? {
        if trueDark { return .dark }
        switch themeMode { case "light": return .light; case "dark": return .dark; default: return nil }
    }

    var body: some View {
        NavigationSplitView {
            SidebarView()
                .navigationSplitViewColumnWidth(min: 220, ideal: 300, max: 480)
        } detail: {
            VStack(spacing: 0) {
                if !model.tabs.isEmpty {
                    TabStripView()
                    Divider()
                }
                if let tab = model.activeTab {
                    HSplitView {
                        SessionTabView(tab: tab)
                            .frame(minWidth: 420)
                        if showInfo {
                            InfoPanelView(tab: tab)
                                .frame(minWidth: 260, idealWidth: 340, maxWidth: 560)
                        }
                    }
                } else {
                    ContentUnavailableView {
                        Label("No session open", systemImage: "bubble.left.and.bubble.right")
                    } description: {
                        Text("Pick a directory on the left and open or start a session.")
                    }
                }
            }
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { showInfo.toggle() } label: {
                        Image(systemName: "sidebar.right")
                    }
                    .help("Toggle info panel")
                    .disabled(model.activeTab == nil)
                }
            }
        }
        .preferredColorScheme(colorScheme)
        .environment(\.locale, Locale(identifier: lang))
    }
}
