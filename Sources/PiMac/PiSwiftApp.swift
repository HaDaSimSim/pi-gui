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
      Color.clear.frame(width: 0, height: 0)
        .background(WindowHider())
        .onAppear {
          appDelegate.model = model
          model.refresh()
          model.restoreTabs()
          // Tear down runtimes (release locks, kill pi) on app quit.
          NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification, object: nil, queue: .main
          ) { _ in MainActor.assumeIsolated { model.disposeAll() } }
          // UI smoke hook
          if let probe = ProcessInfo.processInfo.environment["PISWIFT_UITEST"] {
            model.runUITest(cwdSubstring: probe)
          }
          if let openPath = ProcessInfo.processInfo.environment["PISWIFT_OPEN"] {
            model.openSessionByPath(openPath)
          }
          // Hide the dummy WindowGroup window — real UI is SessionWindowController.
          DispatchQueue.main.async {
            for w in NSApp.windows
            where w.contentView?.subviews.isEmpty ?? true
              || w.frame.size == .zero
            {
              w.orderOut(nil)
            }
            // If no sessions were restored, show a welcome window.
            if model.openSessions.isEmpty {
              appDelegate.showWelcomeWindow()
            }
          }
        }
    }
    .defaultSize(width: 0, height: 0)
    .windowStyle(.hiddenTitleBar)
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
    NSWindow.allowsAutomaticWindowTabbing = true

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
      showWelcomeWindow()
    }
    return true
  }

  /// Show a welcome window when no sessions are restored.
  func showWelcomeWindow() {
    guard let model else { return }
    model.newSession(cwd: FileManager.default.homeDirectoryForCurrentUser.path)
  }
}

// MARK: - WindowHider (hides the dummy WindowGroup NSWindow immediately)

/// An NSViewRepresentable that finds and hides its hosting window on appear.
/// This ensures the zero-size Color.clear WindowGroup window never flashes.
private struct WindowHider: NSViewRepresentable {
  func makeNSView(context: Context) -> NSView {
    let v = NSView()
    DispatchQueue.main.async {
      if let window = v.window {
        window.orderOut(nil)
        window.setFrame(.zero, display: false)
      }
    }
    return v
  }
  func updateNSView(_ nsView: NSView, context: Context) {}
}
