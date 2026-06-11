import PiCore
import SwiftUI

// Native macOS sidebar: List with .sidebar style, always-expanded sections,
// system selection highlighting. Browsing is pure file reads — no runtime spawned.

struct SidebarView: View {
  @Environment(AppModel.self) var model
  @State private var renaming: SessionSummary?
  @State private var renameText = ""
  @State private var deleting: SessionSummary?
  @State private var deleteError: String?
  @State private var selectedSessionPath: String?

  var body: some View {
    List(selection: $selectedSessionPath) {
      ForEach(filteredDirs) { dir in
        Section {
          // "New session" row — subtle
          Button {
            model.newSession(cwd: dir.cwd)
          } label: {
            Text("New session")
              .font(.callout)
              .foregroundStyle(.secondary)
          }
          .buttonStyle(.plain)

          // Session rows
          ForEach(visibleSessions(dir.cwd)) { session in
            SessionRow(summary: session)
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
          Text(Fmt.dirBasename(dir.cwd))
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
    .onChange(of: selectedSessionPath) { _, newPath in
      guard let path = newPath else { return }
      for dir in model.directories {
        if let sessions = model.sessionsByCwd[dir.cwd],
          let session = sessions.first(where: { $0.path == path })
        {
          model.openSession(session)
          break
        }
      }
      DispatchQueue.main.async { selectedSessionPath = nil }
    }
    .onAppear {
      // Ensure all directories have sessions loaded so they show immediately
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

// Session row: title + relative date. No icons, no badges — List handles selection highlighting.
private struct SessionRow: View {
  let summary: SessionSummary

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(summary.name ?? summary.preview ?? "Untitled session")
        .font(.callout)
        .lineLimit(1)
      Text(summary.modified, format: .relative(presentation: .named))
        .font(.caption2)
        .foregroundStyle(.tertiary)
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(summary.name ?? summary.preview ?? "Untitled session")
  }
}

// Filter conditions applied to session list. Kept as a model but no UI shown for it.
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
