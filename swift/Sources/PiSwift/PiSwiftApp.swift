import SwiftUI

@main
struct PiSwiftApp: App {
    @StateObject private var model = AppModel()

    init() {
        if ProcessInfo.processInfo.environment["PISWIFT_SELFTEST"] == "1" {
            SelfTest.run()
            exit(0)
        }
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(model)
                .frame(minWidth: 900, minHeight: 600)
                .onAppear {
                    model.refresh()
                    model.restoreTabs()
                    // UI smoke hook: PISWIFT_UITEST=<cwd substr> auto-opens the newest session
                    // in a matching directory and sends a prompt, to validate the live render path.
                    if let probe = ProcessInfo.processInfo.environment["PISWIFT_UITEST"] {
                        model.runUITest(cwdSubstring: probe)
                    }
                    // Open a specific session file (read-only browse) for visual verification.
                    if let openPath = ProcessInfo.processInfo.environment["PISWIFT_OPEN"] {
                        model.openSessionByPath(openPath)
                    }
                }
        }
        .windowStyle(.titleBar)
        .windowToolbarStyle(.unified)
        .commands {
            CommandGroup(after: .newItem) {
                Button("Open Folder…") { model.pickFolderAndStart() }
                    .keyboardShortcut("o", modifiers: [.command])
                Button("Refresh Sessions") { model.refresh() }
                    .keyboardShortcut("r", modifiers: [.command, .shift])
                Button("Close Tab") { if let id = model.activeTabID { model.closeTab(id) } }
                    .keyboardShortcut("w", modifiers: [.command])
                    .disabled(model.activeTabID == nil)
            }
        }

        Settings {
            SettingsView()
        }
    }
}
