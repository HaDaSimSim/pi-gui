import PiCore
import PiUI
import SwiftUI

@main
struct PiSwiftApp: App {
  @StateObject private var model = AppModel()
  @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

  init() {
    if ProcessInfo.processInfo.environment["PISWIFT_SELFTEST"] == "1" {
      SelfTest.run()
      exit(0)
    }
  }

  var body: some Scene {
    // An invisible utility window group that never actually shows — required so the @main App
    // protocol is satisfied and Settings scene works. The real UI is NSWindow-based (native tabs).
    WindowGroup {
      Color.clear.frame(width: 0, height: 0)
        .onAppear {
          // Hide the SwiftUI-managed window immediately; we use NSWindows for sessions.
          DispatchQueue.main.async {
            for w in NSApp.windows
            where w.windowController == nil || !(w.windowController is SessionWindowController) {
              // Keep Settings windows alive, hide only the dummy WindowGroup window.
              if w.title.isEmpty || w.title == "Window" {
                w.orderOut(nil)
                w.close()
              }
            }
          }
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
          // If no tabs restored and no env hooks, create an empty welcome window.
          if SessionWindowController.all.isEmpty
            && ProcessInfo.processInfo.environment["PISWIFT_UITEST"] == nil
            && ProcessInfo.processInfo.environment["PISWIFT_OPEN"] == nil
          {
            // Open a blank window the user can use to pick a folder.
            appDelegate.showWelcomeWindow()
          }
        }
    }
    .windowStyle(.hiddenTitleBar)
    .defaultSize(width: 0, height: 0)
    .commands {
      CommandGroup(replacing: .newItem) {
        Button("New Tab") { appDelegate.newTab() }
          .keyboardShortcut("t", modifiers: [.command])
        Button("Open Folder…") { model.pickFolderAndStart() }
          .keyboardShortcut("o", modifiers: [.command])
        Button("Refresh Sessions") { model.refresh() }
          .keyboardShortcut("r", modifiers: [.command, .shift])
      }
      // View menu: toggle sidebar + info panel.
      CommandGroup(after: .sidebar) {
        Button("Toggle Info Panel") { appDelegate.toggleInfoPanel() }
          .keyboardShortcut("i", modifiers: [.command, .shift])
      }
      // Session commands.
      CommandGroup(after: .textEditing) {
        Button("Compact Context") { appDelegate.compactCurrentSession() }
          .keyboardShortcut("k", modifiers: [.command])
      }
      // Cmd+1…9 jump to tab N (⌘9 = last tab).
      CommandGroup(after: .toolbar) {
        ForEach(1...9, id: \.self) { n in
          Button("Select Tab \(n)") { appDelegate.activateTab(number: n) }
            .keyboardShortcut(KeyEquivalent(Character("\(n)")), modifiers: [.command])
        }
      }
    }

    Settings {
      SettingsView()
    }
  }
}

// MARK: - AppDelegate (handles native window/tab operations)

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  var model: AppModel?

  func applicationDidFinishLaunching(_ notification: Notification) {
    // Ensure the tab bar shows "+" button for new tabs.
    NSWindow.allowsAutomaticWindowTabbing = true
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    return false
  }

  /// Open a new tab in the key window's cwd (or home directory).
  func newTab() {
    guard let model else { return }
    let cwd =
      (NSApp.keyWindow?.windowController as? SessionWindowController)?.cwd
      ?? FileManager.default.homeDirectoryForCurrentUser.path
    model.newSession(cwd: cwd)
  }

  /// Cmd+1…9: activate the Nth tab in the current tab group.
  func activateTab(number n: Int) {
    guard let keyWindow = NSApp.keyWindow,
      let tabGroup = keyWindow.tabGroup
    else { return }
    let windows = tabGroup.windows
    guard !windows.isEmpty else { return }
    let idx = (n == 9) ? windows.count - 1 : min(n - 1, windows.count - 1)
    windows[idx].makeKeyAndOrderFront(nil)
  }

  /// Show a welcome window when there are no restored sessions.
  func showWelcomeWindow() {
    guard let model else { return }
    let cwd = FileManager.default.homeDirectoryForCurrentUser.path
    model.newSession(cwd: cwd)
  }

  /// Toggle the info panel on the key window's session.
  func toggleInfoPanel() {
    guard let controller = NSApp.keyWindow?.windowController as? SessionWindowController else {
      return
    }
    controller.toggleInfoPanel()
  }

  /// Compact the active session's context (Cmd+K).
  func compactCurrentSession() {
    guard let controller = NSApp.keyWindow?.windowController as? SessionWindowController else {
      return
    }
    controller.runtime.compact()
  }
}
