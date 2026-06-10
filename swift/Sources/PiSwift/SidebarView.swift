import SwiftUI

// Sidebar: two-level browse (directories -> sessions). Pure file reads; opening a session
// creates a tab. New session + refresh live in the bottom bar.
struct SidebarView: View {
    @EnvironmentObject var model: AppModel
    @State private var expanded: Set<String> = []
    @State private var search = ""

    var body: some View {
        VStack(spacing: 0) {
            List {
                ForEach(filteredDirs) { dir in
                    DisclosureGroup(isExpanded: binding(for: dir.cwd)) {
                        ForEach(model.sessionsByCwd[dir.cwd] ?? []) { s in
                            SessionRow(summary: s)
                                .contentShape(Rectangle())
                                .onTapGesture { model.openSession(s) }
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
                        HStack {
                            Image(systemName: "folder")
                                .foregroundStyle(.secondary)
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
            .searchable(text: $search, placement: .sidebar, prompt: "Search directories")

            Divider()
            HStack {
                Text("pi.swift").font(.caption).fontWeight(.semibold)
                    .foregroundStyle(.secondary)
                Spacer()
                Button { model.refresh() } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.borderless)
                SettingsLink { Image(systemName: "gearshape") }
                    .buttonStyle(.borderless)
            }
            .padding(.horizontal, 10).padding(.vertical, 6)
        }
    }

    private var filteredDirs: [AppModel.DirEntry] {
        guard !search.isEmpty else { return model.directories }
        return model.directories.filter { $0.cwd.localizedCaseInsensitiveContains(search) }
    }

    private func binding(for cwd: String) -> Binding<Bool> {
        Binding(
            get: { expanded.contains(cwd) },
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
