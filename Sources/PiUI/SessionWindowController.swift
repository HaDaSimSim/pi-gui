import AppKit
import PiCore
import SwiftUI

// SessionWindowController: one NSWindowController per open session.
// Each window lives in a native titlebar tab group (Ghostty/Safari-style).
// The window's contentView hosts a SwiftUI NavigationSplitView with the shared
// sidebar + this window's specific session detail.
//
// The "+" button is suppressed by NOT implementing newWindowForTab:.
// Tab bar is forced visible even with a single tab.

@MainActor
public final class SessionWindowController: NSWindowController, NSWindowDelegate {
  /// Shared tabbingIdentifier so all session windows form one tab group.
  public static let tabbingId = "pi-sessions"

  /// The runtime session this window/tab displays.
  public let runtime: RuntimeSession

  /// Shared app model (sidebar state, open sessions list).
  private let model: AppModel

  public init(runtime: RuntimeSession, model: AppModel) {
    self.runtime = runtime
    self.model = model

    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1100, height: 750),
      styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
      backing: .buffered,
      defer: true
    )
    window.tabbingMode = .preferred
    window.tabbingIdentifier = Self.tabbingId
    window.title = Self.windowTitle(for: runtime)
    window.setFrameAutosaveName("")  // Don't fight tab group positioning.

    super.init(window: window)
    window.delegate = self

    // Host the SwiftUI content.
    let rootView = SessionWindowRootView(runtime: runtime, model: model)
    let hostingView = NSHostingView(rootView: rootView)
    window.contentView = hostingView

    // Observe displayTitle changes and sync the native tab title.
    Task { @MainActor [weak self] in
      while let self, self.window != nil {
        let title = self.runtime.displayTitle
        if self.window?.title != title {
          self.window?.title = title
        }
        try? await Task.sleep(for: .milliseconds(500))
      }
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("not implemented") }

  // MARK: - Public API

  /// Show this window as a new tab on the key window's tab group, or as a standalone window.
  public func showAsTab() {
    guard let window else { return }
    if let parent = NSApp.keyWindow, parent.tabbingIdentifier == Self.tabbingId {
      parent.addTabbedWindow(window, ordered: .above)
      window.makeKeyAndOrderFront(nil)
    } else {
      showWindow(nil)
    }
    // Force tab bar visible even with a single tab.
    forceTabBarVisible()
  }

  /// Update the native tab title to reflect current session name.
  public func syncTitle() {
    window?.title = Self.windowTitle(for: runtime)
  }

  /// Force the tab bar to stay visible (even with one tab).
  public func forceTabBarVisible() {
    guard let window else { return }
    // Delay slightly — tabGroup isn't always available immediately after window creation.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
      if let tabGroup = window.tabGroup, !tabGroup.isTabBarVisible {
        window.toggleTabBar(nil)
      } else if window.tabGroup == nil {
        // No tab group yet (single window) — toggle creates one and shows the bar.
        window.toggleTabBar(nil)
      }
    }
  }

  private static func windowTitle(for rt: RuntimeSession) -> String {
    return rt.displayTitle
  }

  // MARK: - NSWindowDelegate

  public func windowDidBecomeKey(_ notification: Notification) {
    // When this tab becomes active, update the model's activeSessionId.
    model.activeSessionId = runtime.id
  }

  public func windowWillClose(_ notification: Notification) {
    // Dispose runtime (release lock, kill pi process) and remove from model.
    model.removeWindowController(for: runtime.id)
  }

  public func windowShouldClose(_ sender: NSWindow) -> Bool {
    // Always allow close. removeWindowController handles cleanup.
    // When the last tab closes, the WindowGroup's SessionWindowContent shows the empty state.
    return true
  }
}
