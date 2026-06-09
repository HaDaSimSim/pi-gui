import SwiftUI

// Top-level browser: directories in the sidebar, sessions + chat in the detail.
// NavigationSplitView gives a proper iPad two/three-column layout and collapses
// to a stack on iPhone.
struct BrowserView: View {
    let api: APIClient
    let bus: EventBus
    @EnvironmentObject var app: AppState

    @State private var dirs: [DirectoryInfo] = []
    @State private var selectedDir: DirectoryInfo?
    @State private var selectedSession: SessionInfo?
    @State private var loading = true
    @State private var error: String?
    @State private var showSettings = false

    var body: some View {
        NavigationSplitView {
            directoryList
                .navigationTitle("pi")
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { showSettings = true } label: {
                            Image(systemName: "gearshape")
                        }
                    }
                    ToolbarItem(placement: .topBarLeading) {
                        Button { Task { await load() } } label: {
                            Image(systemName: "arrow.clockwise")
                        }
                    }
                }
        } content: {
            if let dir = selectedDir {
                SessionListView(api: api, cwd: dir.cwd, selection: $selectedSession)
            } else {
                ContentUnavailableView("Select a folder", systemImage: "folder")
            }
        } detail: {
            if let session = selectedSession {
                ChatView(api: api, bus: bus, session: session, cwd: selectedDir?.cwd)
                    .id(session.path)
            } else {
                ContentUnavailableView("Select a session", systemImage: "bubble.left.and.bubble.right")
            }
        }
        .task { await load() }
        .sheet(isPresented: $showSettings) {
            SettingsView()
        }
    }

    @ViewBuilder private var directoryList: some View {
        List(selection: $selectedDir) {
            if loading && dirs.isEmpty {
                ProgressView()
            }
            ForEach(dirs) { dir in
                NavigationLink(value: dir) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(folderName(dir.cwd))
                            .font(.body.weight(.medium))
                            .lineLimit(1)
                        Text(dir.cwd)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.head)
                    }
                    .badge(dir.sessionCount)
                }
            }
            if let error {
                Text(error).font(.footnote).foregroundStyle(.red)
            }
        }
    }

    private func folderName(_ path: String) -> String {
        let parts = path.split(separator: "/")
        return parts.last.map(String.init) ?? path
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            dirs = try await api.directories()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}
