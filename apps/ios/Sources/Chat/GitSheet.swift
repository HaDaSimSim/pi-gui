import SwiftUI

// Git status: branch, changed files, recent commits. Read-only (mirrors web/git-panel.tsx).
struct GitSheet: View {
    let api: APIClient
    let cwd: String
    @Environment(\.dismiss) private var dismiss
    @State private var status: GitStatus?
    @State private var loading = true
    @State private var error: String?

    // The session path isn't a cwd; derive the directory by trimming the file.
    private var dir: String {
        if cwd.hasSuffix(".jsonl"), let r = cwd.range(of: "/", options: .backwards) {
            return String(cwd[..<r.lowerBound])
        }
        return cwd
    }

    var body: some View {
        NavigationStack {
            Group {
                if loading {
                    ProgressView()
                } else if let status, status.isRepo {
                    List {
                        Section("Branch") {
                            LabeledContent("Current", value: status.branch ?? "—")
                            if status.ahead > 0 || status.behind > 0 {
                                LabeledContent("Ahead/Behind", value: "↑\(status.ahead) ↓\(status.behind)")
                            }
                        }
                        if !status.staged.isEmpty {
                            Section("Staged (\(status.staged.count))") {
                                ForEach(status.staged) { fileRow($0) }
                            }
                        }
                        if !status.unstaged.isEmpty {
                            Section("Changed (\(status.unstaged.count))") {
                                ForEach(status.unstaged) { fileRow($0) }
                            }
                        }
                        if !status.untracked.isEmpty {
                            Section("Untracked (\(status.untracked.count))") {
                                ForEach(status.untracked) { fileRow($0) }
                            }
                        }
                        Section("Recent commits") {
                            ForEach(status.commits.prefix(20)) { c in
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(c.subject).font(.callout).lineLimit(2)
                                    HStack(spacing: 8) {
                                        Text(c.shortHash).font(.caption2.monospaced())
                                        Text(c.author).font(.caption2)
                                        Text(c.relTime).font(.caption2)
                                    }
                                    .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                } else {
                    ContentUnavailableView("Not a git repository", systemImage: "arrow.triangle.branch")
                }
            }
            .navigationTitle("Git")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { await load() }
        }
    }

    private func fileRow(_ f: GitFileChange) -> some View {
        HStack(spacing: 8) {
            Text(statusChar(f)).font(.caption.monospaced().weight(.bold)).foregroundStyle(.tint).frame(width: 16)
            Text(f.path).font(.caption).lineLimit(1).truncationMode(.head)
            Spacer()
        }
    }
    private func statusChar(_ f: GitFileChange) -> String {
        if f.untracked { return "?" }
        let s = f.index.trimmingCharacters(in: .whitespaces)
        return s.isEmpty ? f.work.trimmingCharacters(in: .whitespaces) : s
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do { status = try await api.git(cwd: dir) }
        catch { self.error = error.localizedDescription }
    }
}
