import Foundation
import SwiftUI
import Combine

// Top-level app state: browsing (directories/sessions) + open tabs of live runtimes.
// Browsing is pure file reads (never spawns pi). Tabs hold RuntimeSession objects that
// stay alive while open so their RPC streams persist even when not visible.

@MainActor
final class AppModel: ObservableObject {
    @Published var directories: [DirEntry] = []
    @Published var sessionsByCwd: [String: [SessionSummary]] = [:]
    @Published var tabs: [Tab] = []
    @Published var activeTabID: UUID?
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

    struct Tab: Identifiable {
        let id = UUID()
        var title: String
        let cwd: String
        var sessionPath: String?     // nil until a session file exists (pending new session)
        let runtime: RuntimeSession
    }

    var activeTab: Tab? { tabs.first { $0.id == activeTabID } }

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

    // MARK: - Tab persistence

    private let openTabsKey = "piswift.open-tabs"

    private func persistTabs() {
        let paths = tabs.compactMap { $0.sessionPath }
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
            let summary = SessionSummary(id: header.id, path: path, cwd: cwd,
                                         name: meta?.name, modified: meta?.modified ?? Date(),
                                         sizeBytes: meta?.sizeBytes ?? 0, preview: meta?.preview)
            openSession(summary)
        }
    }

    // MARK: - Tabs

    func openSession(_ summary: SessionSummary) {
        if let existing = tabs.first(where: { $0.sessionPath == summary.path }) {
            activeTabID = existing.id
            return
        }
        let rt = RuntimeSession(cwd: summary.cwd, piPath: config.piPath,
                                model: config.defaultModelSpec, sessionDir: nil)
        rt.setSessionPathForBrowsing(summary.path)
        let tab = Tab(title: summary.name ?? summary.preview.map { String($0.prefix(40)) } ?? "Untitled session",
                      cwd: summary.cwd, sessionPath: summary.path, runtime: rt)
        tab.runtime.reloadFromFile()
        tabs.append(tab)
        activeTabID = tab.id
        persistTabs()
    }

    func newSession(cwd: String) {
        let rt = RuntimeSession(cwd: cwd, piPath: config.piPath,
                                model: config.defaultModelSpec, sessionDir: nil)
        let tab = Tab(title: "Untitled session", cwd: cwd, sessionPath: nil, runtime: rt)
        tabs.append(tab)
        activeTabID = tab.id
    }

    func closeTab(_ id: UUID) {
        guard let idx = tabs.firstIndex(where: { $0.id == id }) else { return }
        tabs[idx].runtime.dispose()
        tabs.remove(at: idx)
        if activeTabID == id {
            activeTabID = tabs.last?.id
        }
        persistTabs()
    }

    /// Start the runtime for a tab on first prompt (lazy — browsing didn't spawn pi).
    func ensureRuntimeStarted(for tab: Tab) {
        if !tab.runtime.isStarted {
            try? tab.runtime.start()
        }
    }

    /// UI smoke test: create a NEW session in a matching directory (never touches existing
    /// user sessions), start its runtime, and send a prompt. Validates the live render path.
    func runUITest(cwdSubstring: String) {
        refresh()
        let cwd = directories.first(where: { $0.cwd.contains(cwdSubstring) })?.cwd
            ?? FileManager.default.temporaryDirectory.path
        newSession(cwd: cwd)
        guard let tab = tabs.last else { return }
        ensureRuntimeStarted(for: tab)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
            tab.runtime.sendPrompt("Reply with exactly: NATIVE-OK")
        }
    }
}
