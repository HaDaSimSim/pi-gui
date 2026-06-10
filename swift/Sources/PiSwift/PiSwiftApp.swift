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
          // Tear down runtimes (release locks, kill pi) on app quit so Cmd-Q doesn't
          // leave orphan locks / lingering pi child processes.
          NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification, object: nil, queue: .main
          ) { _ in MainActor.assumeIsolated { model.disposeAll() } }
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
      // Cmd+1…9 jump to tab N (⌘9 = last tab), plus Ctrl-Tab cycling.
      CommandGroup(after: .toolbar) {
        ForEach(1...9, id: \.self) { n in
          Button("Select Tab \(n)") { model.activateTab(number: n) }
            .keyboardShortcut(KeyEquivalent(Character("\(n)")), modifiers: [.command])
        }
        Button("Select Next Tab") { model.cycleTab(by: 1) }
          .keyboardShortcut(.tab, modifiers: [.control])
        Button("Select Previous Tab") { model.cycleTab(by: -1) }
          .keyboardShortcut(.tab, modifiers: [.control, .shift])
      }
    }

    Settings {
      SettingsView()
    }
  }
}
