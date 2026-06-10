import SwiftUI

// Sidebar: master-detail drill-down (directories → that directory's sessions), mirroring the web.
// Pure file reads; opening a session creates a tab. Directory level and session level each have
// their own search; rename/delete live on session rows; new-session/open-folder in the header.
struct SidebarView: View {
    @EnvironmentObject var model: AppModel
    @State private var selectedDir: String?
    @State private var dirSearch = ""
    @State private var sessionSearch = ""
    @State private var renaming: SessionSummary?
    @State private var renameText = ""
    @State private var deleting: SessionSummary?
    @State private var deleteError: String?

    var body: some View {
        VStack(spacing: 0) {
            if let dir = selectedDir {
                sessionLevel(dir)
            } else {
                directoryLevel
            }
            Divider()
            bottomBar
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
    }

    // MARK: - Directory level

    private var directoryLevel: some View {
        List {
            ForEach(filteredDirs) { dir in
                Button {
                    selectedDir = dir.cwd
                    sessionSearch = ""
                    model.loadSessions(forCwd: dir.cwd)
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "folder").foregroundStyle(.secondary)
                            .frame(width: 16)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(Fmt.dirBasename(dir.cwd)).font(.callout).fontWeight(.medium).lineLimit(1)
                            Text(Fmt.tildePath(dir.cwd)).font(.caption2).foregroundStyle(.tertiary)
                                .lineLimit(1).truncationMode(.head)
                        }
                        Spacer(minLength: 4)
                        Text("\(dir.count)").font(.caption2).foregroundStyle(.secondary)
                            .padding(.horizontal, 6).padding(.vertical, 1)
                            .background(Capsule().fill(.quaternary))
                        Image(systemName: "chevron.right").font(.system(size: 10)).foregroundStyle(.tertiary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .listStyle(.sidebar)
        .searchable(text: $dirSearch, placement: .sidebar, prompt: "Search directories")
    }

    // MARK: - Session level

    private func sessionLevel(_ dir: String) -> some View {
        VStack(spacing: 0) {
            // Back + dir name + new session.
            HStack(spacing: 6) {
                Button { selectedDir = nil } label: {
                    Image(systemName: "chevron.left")
                }.buttonStyle(.borderless)
                Text(Fmt.dirBasename(dir)).font(.callout).fontWeight(.semibold).lineLimit(1)
                Spacer()
                Button { model.newSession(cwd: dir) } label: {
                    Image(systemName: "square.and.pencil")
                }.buttonStyle(.borderless).help("New session here")
            }
            .padding(.horizontal, 10).padding(.vertical, 6)
            Divider()
            List {
                ForEach(filteredSessions(dir)) { s in
                    SessionRow(summary: s, isLive: model.isLive(s.path))
                        .contentShape(Rectangle())
                        .onTapGesture { model.openSession(s) }
                        .contextMenu {
                            Button("Open") { model.openSession(s) }
                            Button("Rename…") { renaming = s; renameText = s.name ?? "" }
                            Divider()
                            Button("Delete…", role: .destructive) { deleting = s }
                        }
                }
                if (model.sessionsByCwd[dir] ?? []).isEmpty {
                    Text("No sessions yet").foregroundStyle(.secondary).font(.callout)
                }
            }
            .listStyle(.sidebar)
            .searchable(text: $sessionSearch, placement: .sidebar, prompt: "Search sessions")
        }
    }

    // MARK: - Bottom bar

    private var bottomBar: some View {
        HStack {
            Text("pi").font(.caption).fontWeight(.semibold).foregroundStyle(.secondary)
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

    private var filteredDirs: [AppModel.DirEntry] {
        guard !dirSearch.isEmpty else { return model.directories }
        return model.directories.filter { $0.cwd.localizedCaseInsensitiveContains(dirSearch) }
    }

    private func filteredSessions(_ dir: String) -> [SessionSummary] {
        let all = model.sessionsByCwd[dir] ?? []
        guard !sessionSearch.isEmpty else { return all }
        return all.filter {
            ($0.name ?? "").localizedCaseInsensitiveContains(sessionSearch) ||
            ($0.preview ?? "").localizedCaseInsensitiveContains(sessionSearch)
        }
    }
}

struct SessionRow: View {
    let summary: SessionSummary
    var isLive: Bool = false
    var body: some View {
        HStack(spacing: 8) {
            // Live dot or chat glyph.
            if isLive {
                Circle().fill(Theme.success).frame(width: 7, height: 7).frame(width: 16)
            } else {
                Image(systemName: "bubble.left").font(.caption2).foregroundStyle(.tertiary).frame(width: 16)
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(summary.name ?? summary.preview ?? "Untitled session")
                    .font(.callout).lineLimit(1)
                Text(summary.modified, format: .relative(presentation: .named))
                    .font(.caption2).foregroundStyle(.tertiary)
            }
            Spacer(minLength: 4)
            if summary.sizeBytes > 5_000_000 {
                Image(systemName: "exclamationmark.circle")
                    .font(.caption2).foregroundStyle(.orange)
                    .help("Large session (\(summary.sizeBytes / 1_000_000)MB)")
            }
        }
    }
}
