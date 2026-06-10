import SwiftUI

// Main shell: sidebar (browse) + tab strip + active session + optional info panel.
struct ContentView: View {
    @EnvironmentObject var model: AppModel
    @State private var showInfo = false

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
    }
}
