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
    // Single WindowGroup — native titlebar tabs are achieved by setting
    // tabbingMode = .preferred on the NSWindow (via NativeTabConfigurator).
    // Each window in the tab group shows a different session from openSessions.
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
        Button("New Tab") { appDelegate.newTab() }
          .keyboardShortcut("t", modifiers: [.command])
        Button("New Session") { appDelegate.newSession() }
          .keyboardShortcut("n", modifiers: [.command])
        Button("Open Folder…") { model.pickFolderAndStart() }
          .keyboardShortcut("o", modifiers: [.command])
        Divider()
        Button("Close Tab") { appDelegate.closeActiveTab() }
          .keyboardShortcut("w", modifiers: [.command])
        Divider()
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
      // Tab switching via Cmd+1-9.
      CommandGroup(after: .windowList) {
        ForEach(1...9, id: \.self) { idx in
          Button("Tab \(idx)") { appDelegate.switchToTab(idx - 1) }
            .keyboardShortcut(KeyEquivalent(Character("\(idx)")), modifiers: [.command])
        }
      }
    }

    Settings {
      SettingsView()
    }
  }
}

// MARK: - AppDelegate (handles menu actions + native tab lifecycle)

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  var model: AppModel?

  func applicationDidFinishLaunching(_ notification: Notification) {
    // Disable automatic window tabbing globally — this prevents the "+" button
    // from appearing in the tab bar. We manage tabs manually via SessionWindowController.
    NSWindow.allowsAutomaticWindowTabbing = false

    // Configure the main WindowGroup window to join the session tab group.
    DispatchQueue.main.async {
      if let window = NSApp.windows.first {
        window.tabbingMode = .preferred
        window.tabbingIdentifier = SessionWindowController.tabbingId
        window.title = "pi"
        // Force tab bar visible even with no session tabs.
        if let tabGroup = window.tabGroup, !tabGroup.isTabBarVisible {
          window.toggleTabBar(nil)
        }
      }
    }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    return false
  }

  /// Create a new tab (Cmd+T): new session in the active session's cwd.
  func newTab() {
    guard let model else { return }
    let cwd =
      model.activeSession?.cwd
      ?? FileManager.default.homeDirectoryForCurrentUser.path
    model.newSession(cwd: cwd)
  }

  /// Create a new session (Cmd+N): same as new tab.
  func newSession() {
    newTab()
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

  /// Close the active tab (Cmd+W). Closes the key window, triggering windowWillClose -> dispose.
  func closeActiveTab() {
    if let window = NSApp.keyWindow {
      window.performClose(nil)
    }
  }

  /// Switch to the Nth open tab (0-indexed). Cmd+1 = index 0, etc.
  func switchToTab(_ index: Int) {
    guard let model, index >= 0, index < model.openSessions.count else { return }
    let targetId = model.openSessions[index].id
    model.activeSessionId = targetId
    if let wc = model.windowControllers[targetId] {
      wc.window?.makeKeyAndOrderFront(nil)
    }
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
