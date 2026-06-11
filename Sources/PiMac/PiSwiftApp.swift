import PiCore
import PiUI
import SwiftUI

@main
struct PiSwiftApp: App {
  @State private var model = AppModel()
  @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

  init() {
    if ProcessInfo.processInfo.environment["PISWIFT_SELFTEST"] == "1" {
      SelfTest.run()
      exit(0)
    }
  }

  var body: some Scene {
    // Single persistent window with NavigationSplitView (sidebar + detail).
    WindowGroup {
      SessionWindowContent()
        .environment(model)
        .onAppear {
          appDelegate.model = model
          model.refresh()
          model.restoreTabs()
          // Tear down runtimes (release locks, kill pi) on app quit.
          NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification, object: nil, queue: .main
          ) { _ in MainActor.assumeIsolated { model.disposeAll() } }
          // UI smoke hook: PISWIFT_UITEST=<cwd substr> auto-opens a session and sends a prompt.
          if let probe = ProcessInfo.processInfo.environment["PISWIFT_UITEST"] {
            model.runUITest(cwdSubstring: probe)
          }
          // Open a specific session file (read-only browse) for visual verification.
          if let openPath = ProcessInfo.processInfo.environment["PISWIFT_OPEN"] {
            model.openSessionByPath(openPath)
          }
        }
    }
    .defaultSize(width: 1100, height: 750)
    .commands {
      CommandGroup(replacing: .newItem) {
        Button("New Session") { appDelegate.newSession() }
          .keyboardShortcut("n", modifiers: [.command])
        Button("Open Folder…") { model.pickFolderAndStart() }
          .keyboardShortcut("o", modifiers: [.command])
        Button("Refresh Sessions") { model.refresh() }
          .keyboardShortcut("r", modifiers: [.command, .shift])
      }
      // View menu: toggle info panel.
      CommandGroup(after: .sidebar) {
        Button("Toggle Info Panel") { appDelegate.toggleInfoPanel() }
          .keyboardShortcut("i", modifiers: [.command, .shift])
      }
      // Session commands.
      CommandGroup(after: .textEditing) {
        Button("Compact Context") { appDelegate.compactCurrentSession() }
          .keyboardShortcut("k", modifiers: [.command])
      }
    }

    Settings {
      SettingsView()
    }
  }
}

// MARK: - AppDelegate (minimal — handles menu actions + lifecycle)

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  var model: AppModel?

  func applicationDidFinishLaunching(_ notification: Notification) {
    // No automatic tab bar — sidebar is the navigation.
    NSWindow.allowsAutomaticWindowTabbing = false
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    return false
  }

  /// Create a new session in the active session's cwd (or home directory).
  func newSession() {
    guard let model else { return }
    let cwd =
      model.activeSession?.cwd
      ?? FileManager.default.homeDirectoryForCurrentUser.path
    model.newSession(cwd: cwd)
  }

  /// Toggle the info panel on the active session.
  func toggleInfoPanel() {
    NotificationCenter.default.post(name: .toggleInfoPanel, object: nil)
  }

  /// Compact the active session's context (Cmd+K).
  func compactCurrentSession() {
    guard let model, let rt = model.activeSession else { return }
    model.ensureRuntimeStarted(rt)
    rt.compact()
  }

  /// Re-show the main window when the dock icon is clicked with no visible windows.
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool
  {
    if !flag {
      NSApp.windows.first?.makeKeyAndOrderFront(nil)
    }
    return true
  }
}
