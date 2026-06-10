import SwiftUI

// Full read-only conversation view for a subagent run. The subagent-run custom entry carries
// each turn's complete transcript (thinking/text/toolCall/toolResult with args), so we render
// the child agent's actual conversation — not just a summary card.
struct SubagentDetailView: View {
    let run: SubagentRun
    @Environment(\.dismiss) private var dismiss

    private var statusColor: Color {
        switch run.status {
        case "running": return Theme.streaming
        case "failed", "aborted": return Theme.danger
        default: return Theme.success
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            ScrollView {
                HStack(spacing: 0) {
                    Spacer(minLength: 0)
                    VStack(alignment: .leading, spacing: 20) {
                        ForEach(run.turns) { turn in
                            turnBlock(turn)
                        }
                        if run.turns.isEmpty {
                            // Fallback: a running run before its first turn is persisted.
                            Text(run.task).font(.callout).foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        if let err = run.error {
                            Label(err, systemImage: "exclamationmark.triangle")
                                .foregroundStyle(Theme.danger).font(.callout)
                        }
                    }
                    .frame(maxWidth: 720)
                    .padding(20)
                    Spacer(minLength: 0)
                }
            }
        }
        .frame(minWidth: 560, idealWidth: 760, minHeight: 400, idealHeight: 640)
    }

    private var header: some View {
        HStack(spacing: 10) {
            Circle().fill(statusColor).frame(width: 9, height: 9)
            VStack(alignment: .leading, spacing: 1) {
                Text(run.title).font(.headline)
                HStack(spacing: 6) {
                    if let a = run.agent { Text(a) }
                    if let m = run.model { Text("·"); Text(m) }
                    Text("·"); Text("\(run.turns.count) turn\(run.turns.count == 1 ? "" : "s")")
                    if run.cost > 0 { Text("·"); Text(Fmt.cost(run.cost)) }
                    Text("·"); Text(run.status)
                }
                .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Text("Read-only").font(.caption2).foregroundStyle(.tertiary)
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background(.quaternary, in: Capsule())
            Button("Done") { dismiss() }
                .keyboardShortcut(.cancelAction)
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
    }

    private func turnBlock(_ turn: SubagentTurn) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if run.turns.count > 1 {
                Text("Turn \(turn.index + 1)").font(.caption).foregroundStyle(.tertiary)
            }
            // The prompt sent to the child (rendered like a user message).
            if !turn.prompt.isEmpty {
                Text(turn.prompt)
                    .textSelection(.enabled)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            ForEach(turn.items) { item in
                transcriptItem(item)
            }
            if let err = turn.error {
                Label(err, systemImage: "xmark.octagon").foregroundStyle(Theme.danger).font(.callout)
            }
        }
    }

    @ViewBuilder private func transcriptItem(_ item: SubagentTranscriptItem) -> some View {
        switch item.kind {
        case "thinking":
            DisclosureGroup {
                Text(item.text).font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } label: {
                Label("Thinking", systemImage: "brain").font(.caption).foregroundStyle(.secondary)
            }
        case "toolCall":
            HStack(alignment: .top, spacing: 7) {
                Image(systemName: Theme.toolIcon(item.toolName ?? "")).foregroundStyle(Theme.info)
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.toolName ?? "tool").font(.system(.callout, design: .monospaced)).fontWeight(.medium)
                    if let args = item.args, !args.isEmpty {
                        Text(argSummary(args)).font(.system(.caption, design: .monospaced))
                            .foregroundStyle(.secondary).lineLimit(2)
                    }
                }
                Spacer()
            }
            .padding(8)
            .background(Theme.info.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
        case "toolResult":
            CodeText(String(item.text.prefix(4000)))
                .overlay(alignment: .topTrailing) {
                    if item.isError {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.danger).padding(6)
                    }
                }
        default: // text
            MarkdownView(item.text)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func argSummary(_ args: [String: Any]) -> String {
        for k in ["path", "file_path", "command", "pattern", "query", "url"] {
            if let v = args[k] as? String { return v }
        }
        if let data = try? JSONSerialization.data(withJSONObject: args),
           let s = String(data: data, encoding: .utf8) { return String(s.prefix(160)) }
        return ""
    }
}
