import SwiftUI

// Sessions for one directory. Mirrors the sidebar's per-directory session list.
struct SessionListView: View {
    let api: APIClient
    let cwd: String
    @Binding var selection: SessionInfo?

    @State private var sessions: [SessionInfo] = []
    @State private var loading = true
    @State private var error: String?
    @State private var creating = false

    var body: some View {
        List(selection: $selection) {
            if loading && sessions.isEmpty { ProgressView() }
            ForEach(sessions) { s in
                NavigationLink(value: s) {
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 6) {
                            if s.live {
                                Circle().fill(.green).frame(width: 7, height: 7)
                            }
                            Text(s.displayName)
                                .font(.body)
                                .lineLimit(1)
                        }
                        HStack(spacing: 8) {
                            Text("\(s.messageCount) msgs")
                            Text(relativeTime(s.modified))
                        }
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    }
                }
            }
            if let error {
                Text(error).font(.footnote).foregroundStyle(.red)
            }
        }
        .navigationTitle(folderName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { Task { await newSession() } } label: {
                    Image(systemName: "square.and.pencil")
                }
                .disabled(creating)
            }
        }
        .task(id: cwd) { await load() }
        .refreshable { await load() }
    }

    private var folderName: String {
        cwd.split(separator: "/").last.map(String.init) ?? cwd
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            sessions = try await api.sessions(cwd: cwd)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func newSession() async {
        creating = true
        defer { creating = false }
        do {
            let r = try await api.newSession(cwd: cwd)
            let s = SessionInfo(path: r.path, id: r.id, name: nil, firstMessage: "",
                                messageCount: 0, created: ISO8601DateFormatter().string(from: Date()),
                                modified: ISO8601DateFormatter().string(from: Date()), live: false)
            sessions.insert(s, at: 0)
            selection = s
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func relativeTime(_ iso: String) -> String {
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = fmt.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        guard let date else { return "" }
        let rel = RelativeDateTimeFormatter()
        rel.unitsStyle = .abbreviated
        return rel.localizedString(for: date, relativeTo: Date())
    }
}
