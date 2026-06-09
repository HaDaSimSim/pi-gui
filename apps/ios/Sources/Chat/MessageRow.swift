import SwiftUI

// Renders a single chat message based on its role. Mirrors web/message-view.tsx
// styling intent: user bubbles right-aligned, assistant full-width with
// thinking/tool/subagent sections.
struct MessageRow: View {
    let message: ChatMessage

    var body: some View {
        switch message.role {
        case .user: userBubble
        case .assistant: assistantBlock
        case .subagent: if let run = message.subagentRun { SubagentRunCard(run: run) }
        case .bash: if let b = message.bash { BashRunCard(bash: b) }
        default: EmptyView()
        }
    }

    private var userBubble: some View {
        HStack {
            Spacer(minLength: 40)
            Text(message.text)
                .textSelection(.enabled)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(Color.indigo.opacity(0.15))
                .clipShape(RoundedRectangle(cornerRadius: 16))
        }
    }

    private var assistantBlock: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let thinking = message.thinking, !thinking.isEmpty {
                ThinkingView(text: thinking)
            }
            if !message.text.isEmpty {
                MarkdownText(text: message.text)
            }
            if let calls = message.toolCalls, !calls.isEmpty {
                ForEach(calls) { ToolCallCard(call: $0) }
            }
            if let err = message.errorMessage {
                Label(err, systemImage: "exclamationmark.triangle")
                    .font(.footnote).foregroundStyle(.orange)
            }
            metaLine
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private var metaLine: some View {
        HStack(spacing: 8) {
            if message.streaming {
                ProgressView().controlSize(.mini)
            }
            if let model = message.model {
                Text(model).font(.caption2).foregroundStyle(.secondary)
            }
            if let ms = message.elapsedMs, ms > 0 {
                Text(formatElapsed(ms)).font(.caption2).foregroundStyle(.secondary)
            }
            if message.interrupted {
                Text("interrupted").font(.caption2).foregroundStyle(.orange)
            }
        }
    }

    private func formatElapsed(_ ms: Double) -> String {
        let s = Int(ms / 1000)
        if s >= 60 { return "\(s / 60)m \(s % 60)s" }
        return "\(s)s"
    }
}

struct ThinkingView: View {
    let text: String
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button { withAnimation { expanded.toggle() } } label: {
                Label(expanded ? "Hide reasoning" : "Show reasoning",
                      systemImage: expanded ? "chevron.down" : "chevron.right")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if expanded {
                Text(text)
                    .font(.callout).italic()
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        }
        .padding(.leading, 4)
    }
}

struct ToolCallCard: View {
    let call: ToolCallView
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button { withAnimation { expanded.toggle() } } label: {
                HStack(spacing: 8) {
                    statusIcon
                    Text(call.name).font(.subheadline.monospaced().weight(.medium))
                    Spacer()
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
            .buttonStyle(.plain)
            if expanded {
                if !call.argsText.isEmpty {
                    Text("Arguments").font(.caption2).foregroundStyle(.secondary)
                    CodeBlock(code: call.argsText)
                }
                if let result = call.resultText, !result.isEmpty {
                    Text("Result").font(.caption2).foregroundStyle(.secondary)
                    CodeBlock(code: result)
                }
            }
        }
        .padding(10)
        .background(Color.primary.opacity(0.04))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    @ViewBuilder private var statusIcon: some View {
        switch call.status {
        case .running: ProgressView().controlSize(.mini)
        case .done: Image(systemName: "checkmark.circle.fill").foregroundStyle(.green).font(.caption)
        case .error: Image(systemName: "xmark.circle.fill").foregroundStyle(.red).font(.caption)
        }
    }
}

struct SubagentRunCard: View {
    let run: SubagentRunView
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button { withAnimation { expanded.toggle() } } label: {
                HStack(spacing: 8) {
                    Image(systemName: "person.2.fill").font(.caption).foregroundStyle(.tint)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(run.title.isEmpty ? run.agent : run.title)
                            .font(.subheadline.weight(.medium)).lineLimit(1)
                        Text(run.agent).font(.caption2).foregroundStyle(.secondary)
                    }
                    Spacer()
                    statusBadge
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
            .buttonStyle(.plain)
            if expanded {
                if !run.task.isEmpty {
                    Text(run.task).font(.caption).foregroundStyle(.secondary)
                }
                ForEach(Array(run.turns.enumerated()), id: \.offset) { _, turn in
                    if !turn.finalOutput.isEmpty {
                        MarkdownText(text: turn.finalOutput).font(.callout)
                    }
                    if let err = turn.error {
                        Text(err).font(.caption).foregroundStyle(.red)
                    }
                }
            }
        }
        .padding(12)
        .background(Color.indigo.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private var statusBadge: some View {
        Text(run.status)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(statusColor.opacity(0.18))
            .foregroundStyle(statusColor)
            .clipShape(Capsule())
    }
    private var statusColor: Color {
        switch run.status { case "done": return .green; case "failed": return .red; default: return .orange }
    }
}

struct BashRunCard: View {
    let bash: BashRunView

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "terminal.fill").font(.caption).foregroundStyle(.secondary)
                Text(bash.command).font(.footnote.monospaced()).lineLimit(2)
                if bash.running == true { ProgressView().controlSize(.mini) }
            }
            if !bash.output.isEmpty {
                CodeBlock(code: bash.output)
            }
            if let code = bash.exitCode, code != 0 {
                Text("exit \(code)").font(.caption2).foregroundStyle(.red)
            }
        }
        .padding(10)
        .background(Color.primary.opacity(0.04))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}
