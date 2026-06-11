import PiCore
import SwiftUI

// Native macOS sidebar: List with .sidebar style, Section disclosure, system selection
// highlighting. Browsing is pure file reads; opening a session creates a tab window.

struct SidebarView: View {
  @Environment(AppModel.self) var model
  @State private var expanded: [String: Bool] = [:]
  @State private var search = ""
  @State private var filter = SessionFilterCriteria()
  @State private var showFilter = false
  @State private var renaming: SessionSummary?
  @State private var renameText = ""
  @State private var deleting: SessionSummary?
  @State private var deleteError: String?
  @State private var selectedSessionPath: String?

  var body: some View {
    List(selection: $selectedSessionPath) {
      if filter.isActive {
        HStack(spacing: 6) {
          Image(systemName: "line.3.horizontal.decrease").font(.caption2)
          Text("Filtered").font(.caption2)
          Spacer()
          Button("Clear") {
            filter = SessionFilterCriteria()
          }
          .font(.caption2)
          .buttonStyle(.plain)
          .foregroundStyle(Color.accentColor)
        }
        .foregroundStyle(.secondary)
        .listRowSeparator(.hidden)
      }

      ForEach(filteredDirs) { dir in
        Section(isExpanded: expansionBinding(for: dir.cwd)) {
          // "New session" row
          Button {
            model.newSession(cwd: dir.cwd)
          } label: {
            Label("New session", systemImage: "plus.circle")
              .font(.callout)
              .foregroundStyle(.secondary)
          }
          .buttonStyle(.plain)

          // Session rows
          ForEach(visibleSessions(dir.cwd)) { session in
            SessionRow(summary: session, isLive: model.isLive(session.path))
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
          DirSectionHeader(dir: dir)
        }
      }
    }
    .listStyle(.sidebar)
    .searchable(text: $search, placement: .sidebar, prompt: "Search directories & sessions")
    .onChange(of: search) { _, q in
      if !q.isEmpty {
        for dir in model.directories where model.sessionsByCwd[dir.cwd] == nil {
          model.loadSessions(forCwd: dir.cwd)
        }
      }
    }
    .onChange(of: selectedSessionPath) { _, newPath in
      guard let path = newPath else { return }
      // Find the session summary and open it
      for dir in model.directories {
        if let sessions = model.sessionsByCwd[dir.cwd],
          let session = sessions.first(where: { $0.path == path })
        {
          model.openSession(session)
          break
        }
      }
      // Clear selection so the same row can be tapped again
      DispatchQueue.main.async { selectedSessionPath = nil }
    }
    .safeAreaInset(edge: .top, spacing: 0) {
      VStack(spacing: 0) {
        // Top action bar
        HStack(spacing: 10) {
          Text("π").font(.system(size: 15, weight: .semibold, design: .serif))
            .baselineOffset(2)
            .foregroundStyle(.secondary)
          Spacer()
          Button {
            showFilter = true
          } label: {
            Image(
              systemName: filter.isActive
                ? "line.3.horizontal.decrease.circle.fill"
                : "line.3.horizontal.decrease.circle"
            )
            .font(.system(size: 14))
          }
          .buttonStyle(.plain)
          .foregroundStyle(filter.isActive ? Color.accentColor : .secondary)
          .help("Filter sessions")
          .accessibilityLabel(filter.isActive ? "Filter sessions, active" : "Filter sessions")
          .accessibilityHint("Opens session filter options")
          Button {
            model.pickFolderAndStart()
          } label: {
            Image(systemName: "folder.badge.plus").font(.system(size: 14))
          }
          .buttonStyle(.plain).foregroundStyle(.secondary).help("Open a folder and start a session")
          Button {
            model.refresh()
          } label: {
            Image(systemName: "arrow.clockwise").font(.system(size: 14))
          }
          .buttonStyle(.plain).foregroundStyle(.secondary).help("Refresh")
          SettingsLink { Image(systemName: "gearshape").font(.system(size: 14)) }
            .buttonStyle(.plain).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 12).frame(height: 40)
        Divider()
      }
      .modifier(GlassBarModifier())
    }
    .sheet(isPresented: $showFilter) {
      SessionFilterSheet(filter: $filter)
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

  // MARK: - Expansion

  private func expansionBinding(for cwd: String) -> Binding<Bool> {
    Binding(
      get: {
        // Auto-expand when searching by session name
        if !search.isEmpty && !cwd.localizedCaseInsensitiveContains(search) { return true }
        return expanded[cwd] ?? false
      },
      set: { newValue in
        if newValue && model.sessionsByCwd[cwd] == nil {
          model.loadSessions(forCwd: cwd)
        }
        expanded[cwd] = newValue
      }
    )
  }

  // MARK: - Filtering

  private var filteredDirs: [AppModel.DirEntry] {
    guard !search.isEmpty else { return model.directories }
    let q = search
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
    if filter.liveOnly { all = all.filter { model.isLive($0.path) } }
    if filter.largeOnly { all = all.filter { $0.sizeBytes > 5_000_000 } }
    if let days = filter.lastDays {
      let cutoff = Date().addingTimeInterval(-Double(days) * 86_400)
      all = all.filter { $0.modified > cutoff }
    }
    if !search.isEmpty && !cwd.localizedCaseInsensitiveContains(search) {
      all = all.filter {
        ($0.name ?? "").localizedCaseInsensitiveContains(search)
          || ($0.preview ?? "").localizedCaseInsensitiveContains(search)
      }
    }
    return all
  }
}

// Section header: folder name + path + count badge
private struct DirSectionHeader: View {
  let dir: AppModel.DirEntry
  var body: some View {
    HStack(spacing: 5) {
      Image(systemName: "folder").foregroundStyle(.secondary)
        .font(.caption)
      Text(Fmt.dirBasename(dir.cwd))
        .font(.callout).fontWeight(.medium).lineLimit(1)
      Spacer(minLength: 4)
      Text("\(dir.count)")
        .font(.caption2).foregroundStyle(.secondary)
        .padding(.horizontal, 5).padding(.vertical, 1)
        .background(Capsule().fill(.quaternary))
    }
    .help(Fmt.tildePath(dir.cwd))
  }
}

// Session row: icon + title + relative date. No manual hover/background — List handles it.
struct SessionRow: View {
  let summary: SessionSummary
  var isLive: Bool = false
  var body: some View {
    HStack(spacing: 6) {
      if isLive {
        Circle().fill(Theme.success).frame(width: 6, height: 6).frame(width: 14)
      } else {
        Image(systemName: "bubble.left").font(.caption2).foregroundStyle(.tertiary).frame(
          width: 14)
      }
      VStack(alignment: .leading, spacing: 1) {
        Text(summary.name ?? summary.preview ?? "Untitled session")
          .font(.callout).lineLimit(1)
        Text(summary.modified, format: .relative(presentation: .named))
          .font(.caption2).foregroundStyle(.tertiary)
      }
      Spacer(minLength: 4)
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(
      "\(summary.name ?? summary.preview ?? "Untitled session")\(isLive ? ", live" : "")")
  }
}

// Filter conditions applied to session rows. `isActive` drives the highlighted filter button.
struct SessionFilterCriteria: Equatable {
  var liveOnly = false
  var largeOnly = false
  var lastDays: Int?  // nil = no date limit
  var isActive: Bool { liveOnly || largeOnly || lastDays != nil }
}

private struct SessionFilterSheet: View {
  @Binding var filter: SessionFilterCriteria
  @Environment(\.dismiss) private var dismiss
  @State private var draft = SessionFilterCriteria()
  @State private var daysText = ""

  private let presets = [1, 3, 7, 14, 30]

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        Text("Filter sessions").font(.headline)
        Spacer()
        Button("Done") { commit() }.keyboardShortcut(.defaultAction)
      }
      .padding(.horizontal, 16).padding(.vertical, 12)
      Divider()
      Form {
        Section("Date") {
          Picker(
            "Modified within",
            selection: Binding(
              get: { draft.lastDays ?? 0 },
              set: { draft.lastDays = $0 == 0 ? nil : $0 }
            )
          ) {
            Text("Any time").tag(0)
            ForEach(presets, id: \.self) { d in
              Text("Last \(d) day\(d == 1 ? "" : "s")").tag(d)
            }
          }
          HStack {
            Text("Or last N days")
            Spacer()
            TextField("N", text: $daysText)
              .frame(width: 50).textFieldStyle(.roundedBorder)
              .autocorrectionDisabled()
              .onChange(of: daysText) { _, v in
                if let n = Int(v), n > 0 {
                  draft.lastDays = n
                } else if v.isEmpty { /* keep picker value */
                }
              }
          }
        }
        Section("Status") {
          Toggle("Live sessions only", isOn: $draft.liveOnly)
          Toggle("Large sessions only (>5MB)", isOn: $draft.largeOnly)
        }
        Section {
          Button("Clear all filters", role: .destructive) {
            draft = SessionFilterCriteria()
            daysText = ""
          }
        }
      }
      .formStyle(.grouped)
    }
    .frame(width: 360, height: 380)
    .onAppear {
      draft = filter
      daysText = filter.lastDays.map(String.init) ?? ""
    }
  }

  private func commit() {
    filter = draft
    dismiss()
  }
}

// MARK: - Liquid Glass modifier for control bars (macOS 26+ with fallback)

private struct GlassBarModifier: ViewModifier {
  func body(content: Content) -> some View {
    if #available(macOS 26, *) {
      content.glassEffect(.regular)
    } else {
      content.background(.bar)
    }
  }
}
