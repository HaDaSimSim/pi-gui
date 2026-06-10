import SwiftUI

// Right-side info panel: Info / Subagents / Tasks / Git tabs.
struct InfoPanelView: View {
    let tab: AppModel.Tab
    @ObservedObject var runtime: RuntimeSession
    @State private var selection = 0

    init(tab: AppModel.Tab) {
        self.tab = tab
        self.runtime = tab.runtime
    }

    var body: some View {
        VStack(spacing: 0) {
            Picker("", selection: $selection) {
                Text("Info").tag(0)
                Text("Subagents").tag(1)
                Text("Tasks").tag(2)
                Text("Git").tag(3)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(8)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    switch selection {
                    case 0: infoTab
                    case 1: subagentsTab
                    case 2: tasksTab
                    default: GitTab(cwd: tab.cwd)
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .background(.background)
    }

    private var infoTab: some View {
        VStack(alignment: .leading, spacing: 10) {
            row("Model", runtime.model ?? "—")
            row("Thinking", runtime.thinkingLevel)
            row("Session", runtime.sessionName ?? "—")
            Divider()
            if runtime.footer.contextWindow > 0 {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Context").font(.caption).foregroundStyle(.secondary)
                    ProgressView(value: Double(runtime.footer.contextTokens),
                                 total: Double(runtime.footer.contextWindow))
                    Text("\(Fmt.tokens(runtime.footer.contextTokens))/\(Fmt.tokens(runtime.footer.contextWindow))")
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
            row("Cost", Fmt.cost(runtime.footer.cost))
            row("Input", Fmt.tokens(runtime.footer.inputTokens))
            row("Output", Fmt.tokens(runtime.footer.outputTokens))
            row("Cache R/W", "\(Fmt.tokens(runtime.footer.cacheRead))/\(Fmt.tokens(runtime.footer.cacheWrite))")
        }
    }

    private var subagentsTab: some View {
        let runs = runtime.items.compactMap { item -> SubagentRun? in
            if case .subagentRun(_, let r) = item { return r }; return nil
        }
        return Group {
            if runs.isEmpty {
                Text("No subagent runs yet.").foregroundStyle(.secondary).font(.callout)
            } else {
                ForEach(runs, id: \.runId) { run in
                    TranscriptItemView(item: .subagentRun(id: run.runId, run: run), isStreaming: false)
                }
            }
        }
    }

    private var tasksTab: some View {
        let todos = runtime.items.reversed().compactMap { item -> [TodoItem]? in
            if case .todoList(_, let t) = item { return t }; return nil
        }.first
        return Group {
            if let todos, !todos.isEmpty {
                TodoWidget(todos: todos, isStreaming: runtime.isStreaming)
            } else {
                Text("No goal or todos yet.").foregroundStyle(.secondary).font(.callout)
            }
        }
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Spacer()
            Text(value).font(.caption).fontWeight(.medium).textSelection(.enabled)
        }
    }
}

private struct GitTab: View {
    let cwd: String
    @State private var info = GitInfo()
    @State private var loaded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !loaded {
                ProgressView().task { reload() }
            } else if !info.isRepo {
                Text("Not a git repository.").foregroundStyle(.secondary).font(.callout)
            } else {
                HStack(spacing: 6) {
                    Image(systemName: "arrow.triangle.branch")
                    Text(info.branch ?? "detached").fontWeight(.medium)
                    if info.ahead > 0 { Text("↑\(info.ahead)").foregroundStyle(Theme.success) }
                    if info.behind > 0 { Text("↓\(info.behind)").foregroundStyle(Theme.streaming) }
                    Spacer()
                    Button { reload() } label: { Image(systemName: "arrow.clockwise") }
                        .buttonStyle(.borderless)
                }
                .font(.callout)
                if info.staged.isEmpty && info.unstaged.isEmpty && info.untracked.isEmpty {
                    Label("Working tree clean", systemImage: "checkmark.circle")
                        .font(.caption).foregroundStyle(.secondary)
                } else {
                    fileGroup("Staged", info.staged, Theme.success)
                    fileGroup("Unstaged", info.unstaged, Theme.streaming)
                    fileGroup("Untracked", info.untracked, .secondary)
                }
            }
        }
    }

    @ViewBuilder private func fileGroup(_ title: String, _ files: [String], _ color: Color) -> some View {
        if !files.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.caption2).foregroundStyle(.secondary)
                ForEach(files, id: \.self) { f in
                    Text(f).font(.system(.caption, design: .monospaced))
                        .foregroundStyle(color).lineLimit(1).truncationMode(.middle)
                }
            }
        }
    }

    private func reload() {
        info = GitInfo.load(cwd: cwd)
        loaded = true
    }
}
