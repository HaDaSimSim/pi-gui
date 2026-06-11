import AppKit
import Foundation
import PiCore
import SwiftUI

// Top-level app state: browsing (directories/sessions) + shared config.
// Single-window Finder-style architecture: one persistent window with a fixed sidebar.
// Switching sessions happens via sidebar clicks — no native tab groups.
// Multiple sessions can be OPEN simultaneously (each with their own RuntimeSession/lock),
// but only ONE is shown at a time in the right content panel.

@MainActor
@Observable
public final class AppModel {
  public var directories: [DirEntry] = []
  public var sessionsByCwd: [String: [SessionSummary]] = [:]
  public var models: [ModelOption] = []
  public var locks: [LockRecord] = []

  // Sidebar state.
  public var sidebarExpanded: [String: Bool] = [:]
  public var sidebarSearch = ""
  public var sidebarFilter = SessionFilterCriteria()

  // MARK: - Single-window session management

  /// All currently open sessions (each owns its own RuntimeSession/lock).
  /// Clicking a session in the sidebar sets `activeSessionId`.
  public var openSessions: [RuntimeSession] = []

  /// Window controllers keyed by runtime ID. Each native tab = one controller.
  public var windowControllers: [UUID: SessionWindowController] = [:]

  /// The ID of the session currently displayed in the right content panel.
  public var activeSessionId: UUID?

  /// The currently active (displayed) runtime session.
  public var activeSession: RuntimeSession? {
    guard let id = activeSessionId else { return nil }
    return openSessions.first { $0.id == id }
  }

  public let config: PiConfig
  private let store = SessionStore()

  public struct DirEntry: Identifiable {
    public let cwd: String
    public let count: Int
    public let modified: Date
    public var id: String { cwd }
  }

  public init() {
    self.config = PiConfig.discover()
    self.models = ModelOption.loadAll()
  }

  // MARK: - Browsing (pure file reads)

  public func refresh() {
    let dirs = store.directories()
    directories = dirs.map { DirEntry(cwd: $0.cwd, count: $0.count, modified: $0.modified) }
    locks = listLocks()
  }

  public func loadSessions(forCwd cwd: String) {
    sessionsByCwd[cwd] = store.sessions(forCwd: cwd)
  }

  /// Whether a session path is currently open as a live (started) runtime.
  public func isLive(_ path: String) -> Bool {
    openSessions.contains { $0.sessionPath == path && $0.isStarted }
  }

  // MARK: - Session management (single-window, sidebar-driven)

  /// Open an existing session (or activate it if already open).
  public func openSession(_ summary: SessionSummary) {
    // If already open, just switch to it.
    if let existing = openSessions.first(where: { $0.sessionPath == summary.path }) {
      activeSessionId = existing.id
      activateWindowController(for: existing.id)
      return
    }
    let rt = RuntimeSession(
      cwd: summary.cwd, piPath: config.piPath,
      model: config.defaultModelSpec, sessionDir: nil)
    rt.setSessionPathForBrowsing(summary.path)
    rt.reloadFromFile()
    openSessions.append(rt)
    activeSessionId = rt.id
    showAsNativeTab(rt)
    persistTabs()
  }

  /// Create a brand-new session and make it active.
  public func newSession(cwd: String) {
    let rt = RuntimeSession(
      cwd: cwd, piPath: config.piPath,
      model: config.defaultModelSpec, sessionDir: nil)
    openSessions.append(rt)
    activeSessionId = rt.id
    showAsNativeTab(rt)
  }

  /// Close (dispose) a session by its runtime id.
  public func closeSession(id: UUID) {
    guard let idx = openSessions.firstIndex(where: { $0.id == id }) else { return }
    openSessions[idx].dispose()
    openSessions.remove(at: idx)
    windowControllers.removeValue(forKey: id)
    // If the closed session was active, switch to another.
    if activeSessionId == id {
      activeSessionId = openSessions.last?.id
    }
    persistTabs()
  }

  /// Called by SessionWindowController.windowWillClose — removes the controller
  /// and disposes the runtime without closing the NSWindow again.
  public func removeWindowController(for id: UUID) {
    guard let idx = openSessions.firstIndex(where: { $0.id == id }) else { return }
    openSessions[idx].dispose()
    openSessions.remove(at: idx)
    windowControllers.removeValue(forKey: id)
    if activeSessionId == id {
      activeSessionId = openSessions.last?.id
    }
    persistTabs()
  }

  // MARK: - Native tab helpers

  /// Create a SessionWindowController for the runtime and show it as a native titlebar tab.
  public func showAsNativeTab(_ rt: RuntimeSession) {
    let wc = SessionWindowController(runtime: rt, model: self)
    windowControllers[rt.id] = wc
    wc.showAsTab()
  }

  /// Activate the window/tab for a given runtime ID.
  public func activateWindowController(for id: UUID) {
    guard let wc = windowControllers[id] else { return }
    wc.window?.makeKeyAndOrderFront(nil)
  }

  // MARK: - Tab persistence

  private let openTabsKey = "piswift.open-tabs"

  public func persistTabs() {
    let paths = openSessions.compactMap { $0.sessionPath }
    UserDefaults.standard.set(paths, forKey: openTabsKey)
  }

  /// Restore previously-open sessions (by path). Only existing files are restored;
  /// each is loaded via the cheap browse path (no runtime spawned).
  public func restoreTabs() {
    guard let paths = UserDefaults.standard.stringArray(forKey: openTabsKey) else { return }
    for path in paths where FileManager.default.fileExists(atPath: path) {
      guard let header = try? SessionFile(path: path).header() else { continue }
      let cwd = header.cwd ?? FileManager.default.currentDirectoryPath
      let meta = store.sessions(inDir: (path as NSString).deletingLastPathComponent)
        .first(where: { $0.path == path })
      let summary = SessionSummary(
        id: header.id, path: path, cwd: cwd,
        name: meta?.name, modified: meta?.modified ?? Date(),
        sizeBytes: meta?.sizeBytes ?? 0, preview: meta?.preview)
      openSession(summary)
    }
  }

  /// Tear down every runtime (releases each session lock + terminates pi). Called on app quit.
  public func disposeAll() {
    for rt in openSessions { rt.dispose() }
    openSessions.removeAll()
  }

  /// Rename a session via the live runtime if open, else just trigger the rename.
  public func renameSession(_ summary: SessionSummary, to name: String) {
    if let rt = openSessions.first(where: { $0.sessionPath == summary.path }) {
      ensureRuntimeStarted(rt)
      rt.rename(name)
    }
    loadSessions(forCwd: summary.cwd)
  }

  /// Delete a session file. Refuses if a live/locked runtime holds it.
  public func deleteSession(_ summary: SessionSummary) -> String? {
    if openSessions.contains(where: { $0.sessionPath == summary.path }) {
      return "Session is open \u{2014} close it first."
    }
    if listLocks().contains(where: { $0.sessionPath == summary.path }) {
      return "Session is locked by another writer."
    }
    do {
      try FileManager.default.removeItem(atPath: summary.path)
      loadSessions(forCwd: summary.cwd)
      return nil
    } catch {
      return error.localizedDescription
    }
  }

  /// Open a session directly by file path (read-only browse).
  public func openSessionByPath(_ path: String) {
    guard let header = try? SessionFile(path: path).header() else { return }
    let cwd = header.cwd ?? FileManager.default.currentDirectoryPath
    let meta = store.sessions(inDir: (path as NSString).deletingLastPathComponent)
      .first(where: { $0.path == path })
    let summary = SessionSummary(
      id: header.id, path: path, cwd: cwd,
      name: meta?.name, modified: meta?.modified ?? Date(),
      sizeBytes: meta?.sizeBytes ?? 0, preview: meta?.preview)
    openSession(summary)
  }

  /// Start the runtime lazily (on first prompt). Browse-only sessions stay idle until this.
  public func ensureRuntimeStarted(_ runtime: RuntimeSession) {
    if !runtime.isStarted {
      do {
        try runtime.start()
      } catch {
        runtime.notify("Failed to start pi: \(error.localizedDescription)", type: "error")
      }
    }
  }

  /// Open a native folder picker and start a NEW session in the chosen directory.
  public func pickFolderAndStart() {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.allowsMultipleSelection = false
    panel.prompt = "Start session here"
    panel.message = "Choose a project folder to start a pi session"
    if panel.runModal() == .OK, let url = panel.url {
      newSession(cwd: url.path)
    }
  }

  /// UI smoke test: create a NEW session in a matching directory, start its runtime, send a prompt.
  public func runUITest(cwdSubstring: String) {
    refresh()
    let cwd =
      directories.first(where: { $0.cwd.contains(cwdSubstring) })?.cwd
      ?? FileManager.default.temporaryDirectory.path
    newSession(cwd: cwd)
    guard let rt = openSessions.last else { return }
    ensureRuntimeStarted(rt)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
      rt.sendPrompt("Reply with exactly: NATIVE-OK")
    }
  }
}
