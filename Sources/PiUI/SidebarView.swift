import PiCore
import SwiftUI

// Finder-style sidebar: fixed left panel with section headers in small caps gray text,
// SF Symbol icons, system accent selection highlighting. Sessions are switched by clicking
// here — no native tabs needed.

struct SidebarView: View {
  @Environment(AppModel.self) var model
  @State private var renaming: SessionSummary?
  @State private var renameText = ""
  @State private var deleting: SessionSummary?
  @State private var deleteError: String?

  var body: some View {
    List(
      selection: Binding(
        get: { model.activeSession?.sessionPath },
        set: { newPath in
          if let path = newPath {
            selectSessionByPath(path)
          }
        }
      )
    ) {
      // MARK: - SESSIONS section (open sessions)
      if !model.openSessions.isEmpty {
        Section {
          ForEach(model.openSessions, id: \.id) { rt in
            openSessionRow(rt)
              .tag(rt.sessionPath ?? "")
              .contextMenu {
                Button("Close") { model.closeSession(id: rt.id) }
              }
          }
        } header: {
          Text("SESSIONS")
            .font(.caption)
            .fontWeight(.semibold)
            .foregroundStyle(.secondary)
        }
      }

      // MARK: - PROJECTS section (directory browser)
      ForEach(filteredDirs) { dir in
        Section {
          // "New session" row
          Button {
            model.newSession(cwd: dir.cwd)
          } label: {
            Label("New Session", systemImage: "plus.circle")
              .font(.callout)
              .foregroundStyle(.secondary)
          }
          .buttonStyle(.plain)

          // Session rows from disk
          ForEach(visibleSessions(dir.cwd)) { session in
            sessionRow(session)
              .tag(session.path)
              .contextMenu {
                Button("Open") { model.openSession(session) }
                Button("Rename…") {
                  renaming = session
                  renameText = session.name ?? ""
                }
                Divider()
                Button("Delete…", role: .destructive) { deleting = session }
              }
          }
        } header: {
          Text(Fmt.dirBasename(dir.cwd).uppercased())
            .font(.caption)
            .fontWeight(.semibold)
            .foregroundStyle(.secondary)
            .help(Fmt.tildePath(dir.cwd))
        }
      }
    }
    .listStyle(.sidebar)
    .searchable(
      text: Binding(get: { model.sidebarSearch }, set: { model.sidebarSearch = $0 }),
      placement: .sidebar,
      prompt: "Search"
    )
    .onChange(of: model.sidebarSearch) { _, q in
      if !q.isEmpty {
        for dir in model.directories where model.sessionsByCwd[dir.cwd] == nil {
          model.loadSessions(forCwd: dir.cwd)
        }
      }
    }
    .onAppear {
      for dir in model.directories where model.sessionsByCwd[dir.cwd] == nil {
        model.loadSessions(forCwd: dir.cwd)
      }
    }
    .alert(
      "Rename session",
      isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })
    ) {
      TextField("Name", text: $renameText).autocorrectionDisabled()
      Button("Cancel", role: .cancel) { renaming = nil }
      Button("Rename") {
        if let s = renaming, !renameText.isEmpty { model.renameSession(s, to: renameText) }
        renaming = nil
      }
    }
    .alert(
      "Delete this session?",
      isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })
    ) {
      Button("Cancel", role: .cancel) { deleting = nil }
      Button("Delete", role: .destructive) {
        if let s = deleting { deleteError = model.deleteSession(s) }
        deleting = nil
      }
    } message: {
      Text("This permanently deletes the session file. This cannot be undone.")
    }
    .alert(
      "Couldn't delete",
      isPresented: Binding(get: { deleteError != nil }, set: { if !$0 { deleteError = nil } })
    ) {
      Button("OK") { deleteError = nil }
    } message: {
      Text(deleteError ?? "")
    }
  }

  // MARK: - Row views

  /// Row for an open (live) session in the SESSIONS section.
  @ViewBuilder
  private func openSessionRow(_ rt: RuntimeSession) -> some View {
    Label {
      VStack(alignment: .leading, spacing: 2) {
        Text(rt.sessionName ?? "Untitled session")
          .font(.callout)
          .lineLimit(1)
        Text(Fmt.tildePath(rt.cwd))
          .font(.caption2)
          .foregroundStyle(.tertiary)
          .lineLimit(1)
      }
    } icon: {
      Image(systemName: rt.isStarted ? "circle.fill" : "circle")
        .font(.system(size: 8))
        .foregroundStyle(rt.isStarted ? .green : .secondary)
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(rt.sessionName ?? "Untitled session")
  }

  /// Row for a session from disk in the PROJECTS section.
  @ViewBuilder
  private func sessionRow(_ summary: SessionSummary) -> some View {
    Label {
      VStack(alignment: .leading, spacing: 2) {
        Text(summary.name ?? summary.preview ?? "Untitled session")
          .font(.callout)
          .lineLimit(1)
        Text(summary.modified, format: .relative(presentation: .named))
          .font(.caption2)
          .foregroundStyle(.tertiary)
      }
    } icon: {
      Image(systemName: model.isLive(summary.path) ? "bolt.circle.fill" : "doc.text")
        .font(.system(size: 12))
        .foregroundStyle(model.isLive(summary.path) ? .green : .secondary)
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(summary.name ?? summary.preview ?? "Untitled session")
  }

  // MARK: - Selection

  private func selectSessionByPath(_ path: String) {
    // Check open sessions first.
    if let rt = model.openSessions.first(where: { $0.sessionPath == path }) {
      model.activeSessionId = rt.id
      return
    }
    // Otherwise open from disk.
    for dir in model.directories {
      if let sessions = model.sessionsByCwd[dir.cwd],
        let session = sessions.first(where: { $0.path == path })
      {
        model.openSession(session)
        return
      }
    }
  }

  // MARK: - Filtering

  private var filteredDirs: [AppModel.DirEntry] {
    guard !model.sidebarSearch.isEmpty else { return model.directories }
    let q = model.sidebarSearch
    return model.directories.filter { dir in
      if dir.cwd.localizedCaseInsensitiveContains(q) { return true }
      if let sessions = model.sessionsByCwd[dir.cwd] {
        return sessions.contains {
          ($0.name ?? "").localizedCaseInsensitiveContains(q)
            || ($0.preview ?? "").localizedCaseInsensitiveContains(q)
        }
      }
      return false
    }
  }

  private func visibleSessions(_ cwd: String) -> [SessionSummary] {
    var all = model.sessionsByCwd[cwd] ?? []
    if model.sidebarFilter.liveOnly { all = all.filter { model.isLive($0.path) } }
    if model.sidebarFilter.largeOnly { all = all.filter { $0.sizeBytes > 5_000_000 } }
    if let days = model.sidebarFilter.lastDays {
      let cutoff = Date().addingTimeInterval(-Double(days) * 86_400)
      all = all.filter { $0.modified > cutoff }
    }
    if !model.sidebarSearch.isEmpty && !cwd.localizedCaseInsensitiveContains(model.sidebarSearch) {
      all = all.filter {
        ($0.name ?? "").localizedCaseInsensitiveContains(model.sidebarSearch)
          || ($0.preview ?? "").localizedCaseInsensitiveContains(model.sidebarSearch)
      }
    }
    return all
  }
}

// Filter conditions applied to session list.
public struct SessionFilterCriteria: Equatable {
  public var liveOnly = false
  public var largeOnly = false
  public var lastDays: Int?  // nil = no date limit
  public var isActive: Bool { liveOnly || largeOnly || lastDays != nil }
  public init(liveOnly: Bool = false, largeOnly: Bool = false, lastDays: Int? = nil) {
    self.liveOnly = liveOnly
    self.largeOnly = largeOnly
    self.lastDays = lastDays
  }
}
