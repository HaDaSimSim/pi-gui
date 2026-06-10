import SwiftUI

// Renders a single TranscriptItem. Native chat aesthetic: user messages as trailing bubbles,
// assistant content left-aligned, tools/bash/subagent/todo as inset cards.
struct TranscriptItemView: View {
    let item: TranscriptItem
    let isStreaming: Bool

    var body: some View {
        switch item {
        case .user(_, let text, let ts):
            UserBubble(text: text, timestamp: ts)
        case .assistantText(_, let text, let ts, let modelName):
            AssistantText(text: text, timestamp: ts, model: modelName)
        case .thinking(_, let text):
            ThinkingBlock(text: text)
        case .toolCall(_, let name, let args, let result, let isError):
            ToolCallCard(name: name, args: args, result: result, isError: isError)
        case .bashJob(_, let label, let command, let status, let output):
            BashCard(label: label, command: command, status: status, output: output)
        case .subagentRun(_, let run):
            SubagentCard(run: run)
        case .todoList(_, let todos):
            TodoCard(todos: todos, isStreaming: isStreaming)
        case .goalState(_, let objective, let status):
            GoalCard(objective: objective, status: status)
        case .notice(_, let text):
            HStack {
                Spacer()
                Text(text).font(.caption2).foregroundStyle(.tertiary)
                Spacer()
            }
        }
    }
}

private struct UserBubble: View {
    let text: String
    let timestamp: Date?
    var body: some View {
        VStack(alignment: .trailing, spacing: 2) {
            Text(text)
                .textSelection(.enabled)
                .padding(.horizontal, 14).padding(.vertical, 9)
                .background(Color.accentColor, in: BubbleShape())
                .foregroundStyle(.white)
                .frame(maxWidth: 560, alignment: .trailing)
            if let timestamp {
                Text(timestamp, format: .dateTime.hour().minute())
                    .font(.caption2).foregroundStyle(.tertiary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
}

private struct BubbleShape: Shape {
    func path(in rect: CGRect) -> Path {
        Path(roundedRect: rect, cornerRadii: RectangleCornerRadii(
            topLeading: 16, bottomLeading: 16, bottomTrailing: 4, topTrailing: 16))
    }
}

private struct AssistantText: View {
    let text: String
    let timestamp: Date?
    let model: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            MarkdownView(text)
            if let model {
                HStack(spacing: 6) {
                    Text("Assistant").fontWeight(.medium)
                    Text("·"); Text(model)
                    if let timestamp { Text("·"); Text(timestamp, format: .dateTime.hour().minute()) }
                }
                .font(.caption2).foregroundStyle(.tertiary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct ThinkingBlock: View {
    let text: String
    @State private var expanded = false
    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            Text(text)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "brain")
                Text("Thinking").italic()
                if !expanded {
                    Text(text.prefix(80)).lineLimit(1).foregroundStyle(.tertiary)
                }
            }
            .font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct ToolCallCard: View {
    let name: String
    let args: [String: Any]
    let result: String?
    let isError: Bool
    @State private var expanded = false

    private var argSummary: String {
        let keys = ["path", "file_path", "filePath", "command", "cmd", "pattern", "query", "url", "name", "description"]
        for k in keys { if let v = args[k] as? String { return v } }
        for (_, v) in args { if let s = v as? String { return s }; if let n = v as? Int { return "\(n)" } }
        return ""
    }
    private var statusColor: Color { isError ? Theme.danger : (result == nil ? Theme.streaming : Theme.success) }

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 6) {
                if !args.isEmpty {
                    CodeText(String(describing: argsJSON).prefix(2000).description)
                }
                if let result {
                    Text("result").font(.caption2).foregroundStyle(.tertiary)
                    CodeText(String(result.prefix(4000)))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } label: {
            HStack(spacing: 7) {
                Image(systemName: Theme.toolIcon(name)).foregroundStyle(statusColor)
                Text(name).font(.system(.callout, design: .monospaced)).fontWeight(.medium)
                Text(argSummary).font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary).lineLimit(1)
                Spacer()
                if result != nil {
                    Image(systemName: isError ? "xmark.circle.fill" : "checkmark.circle.fill")
                        .font(.caption2).foregroundStyle(statusColor)
                }
            }
        }
        .padding(8)
        .background(statusColor.opacity(0.07), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(statusColor.opacity(0.25), lineWidth: 1))
    }

    private var argsJSON: Any {
        (try? JSONSerialization.data(withJSONObject: args, options: [.prettyPrinted]))
            .flatMap { String(data: $0, encoding: .utf8) } ?? "\(args)"
    }
}

private struct BashCard: View {
    let label: String
    let command: String
    let status: String
    let output: String
    @State private var expanded = true
    private var color: Color { status == "running" ? Theme.streaming : .secondary }
    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            if !output.isEmpty {
                CodeText(String(output.prefix(16000)))
            }
        } label: {
            HStack(spacing: 7) {
                Image(systemName: "terminal").foregroundStyle(color)
                Text("$ \(command)").font(.system(.caption, design: .monospaced)).lineLimit(1)
                Spacer()
            }
        }
        .padding(8)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
    }
}

private struct SubagentCard: View {
    let run: SubagentRun
    private var color: Color {
        switch run.status {
        case "running": return Theme.streaming
        case "failed", "aborted": return Theme.danger
        default: return Theme.success
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 7) {
                Circle().fill(color).frame(width: 8, height: 8)
                Text(run.title).fontWeight(.medium)
                if let agent = run.agent {
                    Text(agent).font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Capsule().fill(.quaternary))
                }
                Spacer()
            }
            if !run.task.isEmpty {
                Text(run.task).font(.caption).foregroundStyle(.secondary).lineLimit(3)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 8))
    }
}

private struct TodoCard: View {
    let todos: [TodoItem]
    let isStreaming: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            ForEach(sorted) { t in
                HStack(spacing: 7) {
                    icon(for: t)
                    Text(t.status == "in_progress" ? (t.activeForm ?? t.content) : t.content)
                        .font(.callout)
                        .strikethrough(t.status == "completed")
                        .foregroundStyle(t.status == "pending" ? .secondary : .primary)
                    Spacer()
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 8))
    }
    private var sorted: [TodoItem] {
        let order = ["in_progress": 0, "pending": 1, "completed": 2]
        return todos.sorted { (order[$0.status] ?? 1) < (order[$1.status] ?? 1) }
    }
    @ViewBuilder private func icon(for t: TodoItem) -> some View {
        switch t.status {
        case "completed": Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.success)
        case "in_progress":
            if isStreaming { ProgressView().controlSize(.small) }
            else { Image(systemName: "smallcircle.filled.circle").foregroundStyle(Theme.info) }
        default: Image(systemName: "circle").foregroundStyle(.tertiary)
        }
    }
}

private struct GoalCard: View {
    let objective: String
    let status: String
    var body: some View {
        HStack(spacing: 7) {
            Text(Theme.goalEmoji(status))
            VStack(alignment: .leading, spacing: 1) {
                Text(objective).font(.callout).fontWeight(.medium)
                Text("goal \(status)").font(.caption2).foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 8))
    }
}

/// Simple monospaced code box used for tool args/results (MarkdownView handles real fences).
struct CodeText: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(text)
                .font(.system(.caption, design: .monospaced))
                .textSelection(.enabled)
                .padding(8)
        }
        .frame(maxWidth: .infinity, maxHeight: 280, alignment: .leading)
        .background(Color(nsColor: .textBackgroundColor).opacity(0.5),
                    in: RoundedRectangle(cornerRadius: 6))
    }
}
