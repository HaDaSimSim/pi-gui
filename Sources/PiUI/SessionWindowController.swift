import AppKit
import PiCore
import SwiftUI

// NSWindowController subclass that owns one RuntimeSession and participates in native
// macOS window tabbing (Ghostty pattern). Each session = one window; the system renders
// titlebar tabs when multiple windows share the same tabbingIdentifier.

@MainActor
public final class SessionWindowController: NSWindowController, NSWindowDelegate {
  public let runtime: RuntimeSession
  public let cwd: String
  private weak var model: AppModel?
  private var titleObserver: Task<Void, Never>?
  public var showInfoPanel = false

  /// All live session window controllers, derived from NSApp.windows.
  public static var all: [SessionWindowController] {
    NSApp?.windows.compactMap { $0.windowController as? SessionWindowController } ?? []
  }

  /// Convenience: the session file path from the runtime.
  public var sessionPath: String? { runtime.sessionPath }

  public init(runtime: RuntimeSession, cwd: String, title: String, model: AppModel) {
    self.runtime = runtime
    self.cwd = cwd
    self.model = model

    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1000, height: 700),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered,
      defer: false
    )
    window.title = title
    window.subtitle = Fmt.dirBasename(cwd)
    window.titleVisibility = .visible
    window.tabbingMode = .preferred
    window.tabbingIdentifier = "pi-sessions"
    window.isReleasedWhenClosed = false
    window.setFrameAutosaveName("")  // no autosave per instance; let tab group manage
    window.center()

    super.init(window: window)
    window.delegate = self

    // Embed the SwiftUI content view.
    let content = SessionWindowContent(runtime: runtime, cwd: cwd, controller: self)
      .environment(model)
    window.contentView = NSHostingView(rootView: content)
    window.contentView?.autoresizingMask = [.width, .height]

    // Observe runtime.sessionName to update the window title dynamically.
    titleObserver = Task { @MainActor [weak self] in
      var lastName: String? = nil
      while !Task.isCancelled {
        guard let self else { return }
        let name = self.runtime.sessionName
        if name != lastName {
          lastName = name
          if let name, !name.isEmpty {
            self.window?.title = name
          }
        }
        try? await Task.sleep(for: .milliseconds(200))
      }
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("not implemented") }

  /// Show this window as a tab in the current key window's tab group, or as a new window.
  public func showAsTab() {
    guard let window else { return }
    if let parent = NSApp.keyWindow, parent != window,
      parent.tabbingIdentifier == "pi-sessions"
    {
      parent.addTabbedWindow(window, ordered: .above)
      window.makeKeyAndOrderFront(nil)
    } else {
      showWindow(nil)
      window.makeKeyAndOrderFront(nil)
    }
  }

  /// Start the runtime lazily (on first prompt). Browse-only windows stay idle until this.
  public func ensureRuntimeStarted() {
    if !runtime.isStarted {
      do {
        try runtime.start()
      } catch {
        runtime.notify("Failed to start pi: \(error.localizedDescription)", type: "error")
      }
    }
  }

  // MARK: - NSWindowDelegate

  public func windowWillClose(_ notification: Notification) {
    runtime.dispose()
    model?.persistTabs()
  }

  /// Toggle the info panel visibility (bridged from menu Cmd+Shift+I via notification).
  public func toggleInfoPanel() {
    NotificationCenter.default.post(name: .toggleInfoPanel, object: window)
  }

  // Shows the "+" button in the tab bar and responds to its click.
  override public func newWindowForTab(_ sender: Any?) {
    guard let model else { return }
    model.newSession(cwd: cwd)
  }
}
