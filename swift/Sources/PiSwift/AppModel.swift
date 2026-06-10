import AppKit
import Combine
import Foundation
import SwiftUI

// Top-level app state: browsing (directories/sessions) + shared config.
// Browsing is pure file reads (never spawns pi). Each open session lives in its own
// NSWindow managed by SessionWindowController — the OS renders native titlebar tabs.

@MainActor
final class AppModel: ObservableObject {
  @Published var directories: [DirEntry] = []
  @Published var sessionsByCwd: [String: [SessionSummary]] = [:]
  @Published var models: [ModelOption] = []
  @Published var locks: [LockRecord] = []

  let config: PiConfig
  private let store = SessionStore()

  struct DirEntry: Identifiable {
    let cwd: String
    let count: Int
    let modified: Date
    var id: String { cwd }
  }

  init() {
    self.config = PiConfig.discover()
    self.models = ModelOption.loadAll()
  }

  // MARK: - Browsing (pure file reads)

  func refresh() {
    let dirs = store.directories()
    directories = dirs.map { DirEntry(cwd: $0.cwd, count: $0.count, modified: $0.modified) }
    locks = listLocks()
  }

  func loadSessions(forCwd cwd: String) {
    sessionsByCwd[cwd] = store.sessions(forCwd: cwd)
  }

  /// Whether a session path is currently open as a live (started) runtime window.
  func isLive(_ path: String) -> Bool {
    SessionWindowController.all.contains { $0.sessionPath == path && $0.runtime.isStarted }
  }

  // MARK: - Window/tab management (delegates to SessionWindowController)

  /// Open an existing session in a native tab (or activate its existing window).
  func openSession(_ summary: SessionSummary) {
    // If already open, bring its window to front.
    if let existing = SessionWindowController.all.first(where: { $0.sessionPath == summary.path }) {
      existing.window?.makeKeyAndOrderFront(nil)
      return
    }
    let rt = RuntimeSession(
      cwd: summary.cwd, piPath: config.piPath,
      model: config.defaultModelSpec, sessionDir: nil)
    rt.setSessionPathForBrowsing(summary.path)
    let title = summary.name ?? summary.preview.map { String($0.prefix(40)) } ?? "Untitled session"
    let ctrl = SessionWindowController(runtime: rt, cwd: summary.cwd, title: title, model: self)
    rt.reloadFromFile()
    ctrl.showAsTab()
    persistTabs()
  }

  /// Create a brand-new session in a native tab.
  func newSession(cwd: String) {
    let rt = RuntimeSession(
      cwd: cwd, piPath: config.piPath,
      model: config.defaultModelSpec, sessionDir: nil)
    let ctrl = SessionWindowController(
      runtime: rt, cwd: cwd, title: "Untitled session", model: self)
    ctrl.showAsTab()
  }

  // MARK: - Tab persistence

  private let openTabsKey = "piswift.open-tabs"

  func persistTabs() {
    let paths = SessionWindowController.all.compactMap { $0.sessionPath }
    UserDefaults.standard.set(paths, forKey: openTabsKey)
  }

  /// Restore previously-open session tabs (by path). Only existing files are restored;
  /// each is loaded via the cheap browse path (no runtime spawned).
  func restoreTabs() {
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
  func disposeAll() {
    for ctrl in SessionWindowController.all { ctrl.runtime.dispose() }
  }

  /// Rename a session via the live runtime if open, else just trigger the rename.
  func renameSession(_ summary: SessionSummary, to name: String) {
    if let ctrl = SessionWindowController.all.first(where: { $0.sessionPath == summary.path }) {
      ctrl.ensureRuntimeStarted()
      ctrl.runtime.rename(name)
    }
    loadSessions(forCwd: summary.cwd)
  }

  /// Delete a session file. Refuses if a live/locked runtime holds it.
  func deleteSession(_ summary: SessionSummary) -> String? {
    if SessionWindowController.all.contains(where: { $0.sessionPath == summary.path }) {
      return "Session is open \u{2014} close its window first."
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
  func openSessionByPath(_ path: String) {
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

  /// Open a native folder picker and start a NEW session in the chosen directory.
  func pickFolderAndStart() {
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
  func runUITest(cwdSubstring: String) {
    refresh()
    let cwd =
      directories.first(where: { $0.cwd.contains(cwdSubstring) })?.cwd
      ?? FileManager.default.temporaryDirectory.path
    newSession(cwd: cwd)
    guard let ctrl = SessionWindowController.all.last else { return }
    ctrl.ensureRuntimeStarted()
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
      ctrl.runtime.sendPrompt("Reply with exactly: NATIVE-OK")
    }
  }
}
