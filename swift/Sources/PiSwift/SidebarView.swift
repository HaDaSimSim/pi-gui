import SwiftUI

// Sidebar: two-level browse (directories -> sessions). Pure file reads; opening a session
// creates a tab. New session + refresh live in the bottom bar.
struct SidebarView: View {
    @EnvironmentObject var model: AppModel
    @State private var expanded: Set<String> = []
    @State private var search = ""
    @State private var renaming: SessionSummary?
    @State private var renameText = ""
    @State private var deleting: SessionSummary?
    @State private var deleteError: String?

    var body: some View {
        VStack(spacing: 0) {
            List {
                ForEach(filteredDirs) { dir in
                    DisclosureGroup(isExpanded: binding(for: dir.cwd)) {
                        ForEach(visibleSessions(dir.cwd)) { s in
                            SessionRow(summary: s)
                                .contentShape(Rectangle())
                                .onTapGesture { model.openSession(s) }
                                .contextMenu {
                                    Button("Open") { model.openSession(s) }
                                    Button("Rename…") { renaming = s; renameText = s.name ?? "" }
                                    Divider()
                                    Button("Delete…", role: .destructive) { deleting = s }
                                }
                        }
                        Button {
                            model.newSession(cwd: dir.cwd)
                        } label: {
                            Label("New session", systemImage: "plus.circle")
                                .font(.callout)
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(.secondary)
                    } label: {
                        HStack(alignment: .center, spacing: 8) {
                            Image(systemName: "folder")
                                .foregroundStyle(.secondary)
                                .frame(width: 16, alignment: .center)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(Fmt.dirBasename(dir.cwd))
                                    .font(.callout).fontWeight(.medium)
                                    .lineLimit(1)
                                Text(Fmt.tildePath(dir.cwd))
                                    .font(.caption2).foregroundStyle(.tertiary)
                                    .lineLimit(1).truncationMode(.head)
                            }
                            Spacer()
                            Text("\(dir.count)")
                                .font(.caption2).foregroundStyle(.secondary)
                                .padding(.horizontal, 6).padding(.vertical, 1)
                                .background(Capsule().fill(.quaternary))
                        }
                    }
                    .onChange(of: expanded.contains(dir.cwd)) { _, isOpen in
                        if isOpen && model.sessionsByCwd[dir.cwd] == nil {
                            model.loadSessions(forCwd: dir.cwd)
                        }
                    }
                }
            }
            .listStyle(.sidebar)
            .searchable(text: $search, placement: .sidebar, prompt: "Search directories & sessions")
            .onChange(of: search) { _, q in
                // Load all directories' sessions so name search can match before expanding.
                if !q.isEmpty {
                    for dir in model.directories where model.sessionsByCwd[dir.cwd] == nil {
                        model.loadSessions(forCwd: dir.cwd)
                    }
                }
            }
            .alert("Rename session", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
                TextField("Name", text: $renameText).disableAutocorrection(true)
                Button("Cancel", role: .cancel) { renaming = nil }
                Button("Rename") {
                    if let s = renaming, !renameText.isEmpty { model.renameSession(s, to: renameText) }
                    renaming = nil
                }
            }
            .alert("Delete this session?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) {
                Button("Cancel", role: .cancel) { deleting = nil }
                Button("Delete", role: .destructive) {
                    if let s = deleting { deleteError = model.deleteSession(s) }
                    deleting = nil
                }
            } message: {
                Text("This permanently deletes the session file. This cannot be undone.")
            }
            .alert("Couldn't delete", isPresented: Binding(get: { deleteError != nil }, set: { if !$0 { deleteError = nil } })) {
                Button("OK") { deleteError = nil }
            } message: { Text(deleteError ?? "") }

            Divider()
            HStack {
                Text("pi").font(.caption).fontWeight(.semibold)
                    .foregroundStyle(.secondary)
                Spacer()
                Button { model.pickFolderAndStart() } label: { Image(systemName: "folder.badge.plus") }
                    .buttonStyle(.borderless).help("Open a folder and start a session")
                Button { model.refresh() } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.borderless).help("Refresh")
                SettingsLink { Image(systemName: "gearshape") }
                    .buttonStyle(.borderless)
            }
            .padding(.horizontal, 10).padding(.vertical, 6)
        }
    }

    private var filteredDirs: [AppModel.DirEntry] {
        guard !search.isEmpty else { return model.directories }
        let q = search
        return model.directories.filter { dir in
            if dir.cwd.localizedCaseInsensitiveContains(q) { return true }
            // Also match directories that contain a session whose name/preview matches.
            if let sessions = model.sessionsByCwd[dir.cwd] {
                return sessions.contains { ($0.name ?? "").localizedCaseInsensitiveContains(q)
                    || ($0.preview ?? "").localizedCaseInsensitiveContains(q) }
            }
            return false
        }
    }

    /// Sessions in a directory, filtered by the search query when it matches names (so a
    /// directory matched only by session name shows just the matching sessions).
    private func visibleSessions(_ cwd: String) -> [SessionSummary] {
        let all = model.sessionsByCwd[cwd] ?? []
        guard !search.isEmpty, !cwd.localizedCaseInsensitiveContains(search) else { return all }
        return all.filter { ($0.name ?? "").localizedCaseInsensitiveContains(search)
            || ($0.preview ?? "").localizedCaseInsensitiveContains(search) }
    }

    private func binding(for cwd: String) -> Binding<Bool> {
        Binding(
            get: {
                // While searching, auto-expand directories matched by a session name.
                if !search.isEmpty && !cwd.localizedCaseInsensitiveContains(search) { return true }
                return expanded.contains(cwd)
            },
            set: { isOpen in
                if isOpen { expanded.insert(cwd) } else { expanded.remove(cwd) }
            }
        )
    }
}

struct SessionRow: View {
    let summary: SessionSummary
    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "bubble.left")
                .font(.caption2)
                .foregroundStyle(.tertiary)
            VStack(alignment: .leading, spacing: 1) {
                Text(summary.name ?? summary.preview ?? "Untitled session")
                    .font(.callout).lineLimit(1)
                Text(summary.modified, format: .relative(presentation: .named))
                    .font(.caption2).foregroundStyle(.tertiary)
            }
            Spacer()
            if summary.sizeBytes > 5_000_000 {
                Image(systemName: "exclamationmark.circle")
                    .font(.caption2).foregroundStyle(.orange)
                    .help("Large session (\(summary.sizeBytes / 1_000_000)MB)")
            }
        }
    }
}
