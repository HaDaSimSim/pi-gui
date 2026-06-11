import PiCore
import SwiftUI

// Sidebar: two-level browse (directories -> sessions). Pure file reads; opening a session
// creates a tab. New session + refresh live in the bottom bar.
struct SidebarView: View {
  @EnvironmentObject var model: AppModel
  @State private var expanded: Set<String> = []
  @State private var search = ""
  @State private var filter = SessionFilterCriteria()
  @State private var showFilter = false
  @State private var renaming: SessionSummary?
  @State private var renameText = ""
  @State private var deleting: SessionSummary?
  @State private var deleteError: String?

  var body: some View {
    VStack(spacing: 0) {
      // Top action bar (HIG: don't put actions at the bottom of a sidebar — the bottom
      // edge is often dragged off-screen). Browse actions + filter live up top.
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
              ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle"
          )
          .font(.system(size: 14))
        }
        .buttonStyle(.plain)
        .foregroundStyle(filter.isActive ? Color.accentColor : .secondary)
        .help("Filter sessions")
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
      if filter.isActive {
        HStack(spacing: 6) {
          Image(systemName: "line.3.horizontal.decrease").font(.caption2)
          Text("Filtered").font(.caption2)
          Spacer()
          Button {
            filter = SessionFilterCriteria()
          } label: {
            Text("Clear").font(.caption2)
          }.buttonStyle(.plain).foregroundStyle(Color.accentColor)
        }
        .foregroundStyle(.secondary)
        .padding(.horizontal, 12).padding(.vertical, 4)
        .background(Color.accentColor.opacity(0.12))
      }
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 1) {
          ForEach(filteredDirs) { dir in
            DirHeaderRow(
              dir: dir,
              expanded: isExpanded(dir.cwd),
              toggle: { toggle(dir.cwd) }
            )
            if isExpanded(dir.cwd) {
              Button {
                model.newSession(cwd: dir.cwd)
              } label: {
                Label("New session", systemImage: "plus.circle").font(.caption)
              }
              .buttonStyle(.plain).foregroundStyle(.secondary)
              .padding(.leading, 22).padding(.vertical, 3)
              ForEach(visibleSessions(dir.cwd)) { s in
                SessionRow(summary: s, isLive: model.isLive(s.path))
                  .padding(.leading, 22).padding(.trailing, 4)
                  .padding(.vertical, 1)
                  .frame(maxWidth: .infinity, alignment: .leading)
                  .contentShape(Rectangle())
                  .onTapGesture { model.openSession(s) }
                  .contextMenu {
                    Button("Open") { model.openSession(s) }
                    Button("Rename…") {
                      renaming = s
                      renameText = s.name ?? ""
                    }
                    Divider()
                    Button("Delete…", role: .destructive) { deleting = s }
                  }
              }
            }
          }
        }
        .padding(.horizontal, 8).padding(.vertical, 6)
        .animation(.easeInOut(duration: 0.2), value: expanded)
        .animation(.easeInOut(duration: 0.2), value: filter)
      }
      .searchable(text: $search, placement: .sidebar, prompt: "Search directories & sessions")
      .onChange(of: search) { _, q in
        // Load all directories' sessions so name search can match before expanding.
        if !q.isEmpty {
          for dir in model.directories where model.sessionsByCwd[dir.cwd] == nil {
            model.loadSessions(forCwd: dir.cwd)
          }
        }
      }
      .sheet(isPresented: $showFilter) {
        SessionFilterSheet(filter: $filter)
      }
      .alert(
        "Rename session",
        isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })
      ) {
        TextField("Name", text: $renameText).disableAutocorrection(true)
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
  }

  private var filteredDirs: [AppModel.DirEntry] {
    guard !search.isEmpty else { return model.directories }
    let q = search
    return model.directories.filter { dir in
      if dir.cwd.localizedCaseInsensitiveContains(q) { return true }
      // Also match directories that contain a session whose name/preview matches.
      if let sessions = model.sessionsByCwd[dir.cwd] {
        return sessions.contains {
          ($0.name ?? "").localizedCaseInsensitiveContains(q)
            || ($0.preview ?? "").localizedCaseInsensitiveContains(q)
        }
      }
      return false
    }
  }

  /// Sessions in a directory, filtered by the search query when it matches names (so a
  /// directory matched only by session name shows just the matching sessions).
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

  private func isExpanded(_ cwd: String) -> Bool {
    // While searching, auto-expand directories matched only by a session name.
    if !search.isEmpty && !cwd.localizedCaseInsensitiveContains(search) { return true }
    return expanded.contains(cwd)
  }

  private func toggle(_ cwd: String) {
    if expanded.contains(cwd) {
      withAnimation(.easeInOut(duration: 0.2)) { _ = expanded.remove(cwd) }
    } else {
      if model.sessionsByCwd[cwd] == nil { model.loadSessions(forCwd: cwd) }
      withAnimation(.easeInOut(duration: 0.2)) { _ = expanded.insert(cwd) }
    }
  }
}

// Directory header row: fixed-width chevron aligned with the folder icon, hover highlight,
// consistent left/right padding (the List/Section version dropped the trailing inset).
private struct DirHeaderRow: View {
  let dir: AppModel.DirEntry
  let expanded: Bool
  let toggle: () -> Void
  @State private var hovering = false
  var body: some View {
    Button(action: toggle) {
      HStack(spacing: 6) {
        Image(systemName: "chevron.right")
          .font(.system(size: 9, weight: .semibold))
          .foregroundStyle(.secondary)
          .rotationEffect(.degrees(expanded ? 90 : 0))
          .frame(width: 12, alignment: .center)
        Image(systemName: "folder").foregroundStyle(.secondary)
          .frame(width: 16, alignment: .center)
        VStack(alignment: .leading, spacing: 1) {
          Text(Fmt.dirBasename(dir.cwd))
            .font(.callout).fontWeight(.medium).lineLimit(1)
          Text(Fmt.tildePath(dir.cwd))
            .font(.caption2).foregroundStyle(.tertiary)
            .lineLimit(1).truncationMode(.head)
        }
        Spacer(minLength: 4)
        Text("\(dir.count)")
          .font(.caption2).foregroundStyle(.secondary)
          .padding(.horizontal, 6).padding(.vertical, 1)
          .background(Capsule().fill(.quaternary))
      }
      .padding(.horizontal, 6).padding(.vertical, 5)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(
        hovering ? Color.secondary.opacity(0.1) : .clear,
        in: RoundedRectangle(cornerRadius: 6)
      )
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
  }
}

struct SessionRow: View {
  let summary: SessionSummary
  var isLive: Bool = false
  @State private var hovering = false
  var body: some View {
    HStack(spacing: 6) {
      if isLive {
        Circle().fill(Theme.success).frame(width: 6, height: 6).frame(width: 14)
      } else {
        Image(systemName: "bubble.left").font(.caption2).foregroundStyle(.tertiary).frame(width: 14)
      }
      VStack(alignment: .leading, spacing: 1) {
        Text(summary.name ?? summary.preview ?? "Untitled session")
          .font(.callout).lineLimit(1)
        Text(summary.modified, format: .relative(presentation: .named))
          .font(.caption2).foregroundStyle(.tertiary)
      }
      Spacer(minLength: 4)
    }
    .padding(.horizontal, 6).padding(.vertical, 4)
    .background(
      hovering ? Color.secondary.opacity(0.12) : .clear,
      in: RoundedRectangle(cornerRadius: 6)
    )
    .onHover { hovering = $0 }
    .animation(.easeOut(duration: 0.12), value: hovering)
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
              .disableAutocorrection(true)
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
