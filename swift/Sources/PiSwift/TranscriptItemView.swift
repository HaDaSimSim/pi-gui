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
    case .assistant(_, let msg):
      AssistantMessageView(msg: msg, isStreaming: isStreaming)
    case .bashJob(_, let job):
      BashCard(job: job)
    case .subagentRun(_, let run):
      SubagentCard(run: run)
    case .todoList(_, let todos):
      TodoCard(todos: todos, isStreaming: isStreaming)
    case .goalState(_, let objective, let status):
      GoalCard(objective: objective, status: status)
    case .btwAnswer(_, let question, let answer):
      BtwCard(question: question, answer: answer)
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
        .fixedSize(horizontal: false, vertical: true)
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
    Path(
      roundedRect: rect,
      cornerRadii: RectangleCornerRadii(
        topLeading: 16, bottomLeading: 16, bottomTrailing: 4, topTrailing: 16))
  }
}

private struct AssistantMessageView: View {
  let msg: AssistantMessage
  let isStreaming: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if let thinking = msg.thinking, !thinking.isEmpty {
        ThinkingBlock(text: thinking)
      }
      if !msg.text.isEmpty {
        MarkdownView(msg.text)
      } else if msg.thinking == nil && msg.toolCalls.isEmpty {
        Text("…").foregroundStyle(.secondary)
      }
      if !msg.toolCalls.isEmpty {
        VStack(alignment: .leading, spacing: 5) {
          ForEach(msg.toolCalls) { tc in
            ToolCallCard(
              name: tc.name, args: tc.args,
              result: tc.resultText,
              isError: tc.status == "error",
              running: tc.status == "running",
              unknown: tc.status == "unknown")
          }
        }
      }
      // Interrupted: a red rule with a centered notch label.
      if msg.interrupted {
        InterruptedRule()
      } else if let err = msg.errorMessage, !err.isEmpty {
        HStack(alignment: .top, spacing: 6) {
          Image(systemName: "exclamationmark.octagon.fill").foregroundStyle(Theme.danger)
          Text(err).foregroundStyle(Theme.danger)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .font(.caption)
      }
      // Meta: on a finished turn (elapsed set) or while THIS message is streaming.
      if msg.elapsed != nil || msg.streaming {
        HStack(spacing: 6) {
          if msg.elapsed != nil {
            Text("Assistant").fontWeight(.medium)
            if let m = msg.model {
              Text("·")
              Text(m)
            }
            if let e = msg.elapsed {
              Text("·")
              Text(Fmt.elapsed(e * 1000))
            }
            if let ts = msg.timestamp {
              Text("·")
              Text(ts, format: .dateTime.hour().minute())
            }
          }
          if msg.streaming {
            ProgressView().controlSize(.small)
            Text("working…").font(.caption2).foregroundStyle(.tertiary)
          }
        }
        .font(.caption2).foregroundStyle(.tertiary)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

/// Red horizontal rule with a centered “interrupted” notch (mirrors the TUI/web interrupt marker).
private struct InterruptedRule: View {
  var body: some View {
    HStack(spacing: 8) {
      Rectangle().fill(Theme.danger.opacity(0.6)).frame(height: 1)
      Text("interrupted").font(.caption2).foregroundStyle(Theme.danger)
      Rectangle().fill(Theme.danger.opacity(0.6)).frame(height: 1)
    }
    .padding(.vertical, 2)
  }
}

private struct ThinkingBlock: View {
  let text: String
  @State private var expanded = false
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      // Whole row toggles; chevron sits right after the text/preview.
      Button {
        expanded.toggle()
      } label: {
        HStack(spacing: 6) {
          Image(systemName: "brain")
          Text("Thinking").italic()
          if !expanded {
            Text(text.prefix(80)).lineLimit(1).foregroundStyle(.tertiary)
          }
          Image(systemName: "chevron.right")
            .font(.system(size: 9))
            .rotationEffect(.degrees(expanded ? 90 : 0))
            .frame(width: 12, alignment: .center)
          Spacer(minLength: 0)
        }
        .font(.caption).foregroundStyle(.secondary)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      if expanded {
        // No indent: text aligns to the same leading edge as the label.
        Text(text)
          .font(.system(.caption, design: .monospaced))
          .foregroundStyle(.secondary)
          .textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading)
          .transition(.opacity.combined(with: .move(edge: .top)))
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .animation(.easeInOut(duration: 0.2), value: expanded)
  }
}

private struct ToolCallCard: View {
  let name: String
  let args: [String: Any]
  let result: String?
  let isError: Bool
  var running: Bool = false
  var unknown: Bool = false
  @State private var expanded = false

  private var argSummary: String {
    let keys = [
      "path", "file_path", "filePath", "command", "cmd", "pattern", "query", "url", "name",
      "description",
    ]
    for k in keys { if let v = args[k] as? String { return v } }
    for k in args.keys.sorted() {
      let v = args[k]!
      if let s = v as? String { return s }
      if let n = v as? Int { return "\(n)" }
    }
    return ""
  }
  private var statusColor: Color {
    if isError { return Theme.danger }
    if running { return Theme.streaming }
    if unknown { return .secondary }
    return Theme.success
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      // Whole box (incl. padding) toggles; chevron pinned to the right edge.
      Button {
        expanded.toggle()
      } label: {
        HStack(spacing: 6) {
          // Icon + tool name in a status-colored chip for a consistent, tidy left edge.
          HStack(spacing: 4) {
            Image(systemName: Theme.toolIcon(name)).font(.system(size: 10))
            Text(name).font(.system(.caption2, design: .monospaced)).fontWeight(.medium)
          }
          .foregroundStyle(statusColor)
          .padding(.horizontal, 6).padding(.vertical, 2)
          .background(statusColor.opacity(0.12), in: Capsule())
          Text(argSummary).font(.system(.caption2, design: .monospaced))
            .foregroundStyle(.secondary).lineLimit(1)
          Spacer(minLength: 4)
          if unknown {
            Image(systemName: "questionmark.circle")
              .font(.system(size: 10)).foregroundStyle(.tertiary)
              .help("Result is outside the loaded history window")
          } else if result != nil {
            Image(systemName: isError ? "xmark.circle.fill" : "checkmark.circle.fill")
              .font(.system(size: 10)).foregroundStyle(statusColor)
          }
          Image(systemName: "chevron.right")
            .font(.system(size: 9)).foregroundStyle(.tertiary)
            .rotationEffect(.degrees(expanded ? 90 : 0))
            .frame(width: 12, alignment: .center)
        }
        .padding(.horizontal, 8).padding(.vertical, 6)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      if expanded {
        VStack(alignment: .leading, spacing: 6) {
          if !args.isEmpty {
            CodeText(String(describing: argsJSON).prefix(2000).description)
          }
          if let result {
            Text("result").font(.caption2).foregroundStyle(.tertiary)
            CodeText(String(result.prefix(4000)))
          }
        }
        .padding(.horizontal, 8).padding(.bottom, 6)
        .transition(.opacity.combined(with: .move(edge: .top)))
      }
    }
    .animation(.easeInOut(duration: 0.2), value: expanded)
    .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 7))
    .overlay(RoundedRectangle(cornerRadius: 7).stroke(Color.secondary.opacity(0.15), lineWidth: 1))
  }

  private var argsJSON: Any {
    (try? JSONSerialization.data(withJSONObject: args, options: [.prettyPrinted]))
      .flatMap { String(data: $0, encoding: .utf8) } ?? "\(args)"
  }
}

private struct BashCard: View {
  let job: BashJobView
  @State private var expanded = true
  private var running: Bool { job.status == "running" }
  private var failed: Bool { job.status == "failed" || (job.exitCode ?? 0) != 0 }
  private var color: Color {
    if running { return Theme.streaming }
    if failed || job.status == "cancelled" { return Theme.danger }
    return .secondary
  }
  var body: some View {
    DisclosureGroup(isExpanded: $expanded) {
      if !job.output.isEmpty {
        CodeText(String(job.output.prefix(16000)) + (job.truncated ? "\n\n[output truncated]" : ""))
      }
    } label: {
      HStack(spacing: 7) {
        if running {
          ProgressView().controlSize(.small)
        } else {
          Image(systemName: "terminal").foregroundStyle(color)
        }
        Text("$ \(job.command)").font(.system(.caption, design: .monospaced)).lineLimit(1)
        Spacer()
        if job.excludeFromContext {
          Text("no context").font(.caption2).foregroundStyle(.secondary)
            .padding(.horizontal, 5).padding(.vertical, 1)
            .background(Capsule().fill(.quaternary))
        }
        if let exit = job.exitCode, exit != 0 {
          Text("exit \(exit)").font(.system(.caption2, design: .monospaced))
            .foregroundStyle(Theme.danger)
        } else if job.status == "cancelled" {
          Text("cancelled").font(.caption2).foregroundStyle(Theme.danger)
        }
      }
    }
    .padding(8)
    .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
  }
}

private struct SubagentCard: View {
  let run: SubagentRun
  @State private var showDetail = false
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
        if run.turns.count > 1 {
          Text("\(run.turns.count) turns").font(.caption2).foregroundStyle(.tertiary)
        }
        Image(systemName: "arrow.up.left.and.arrow.down.right")
          .font(.caption2).foregroundStyle(.tertiary)
      }
      if !run.task.isEmpty {
        Text(run.task).font(.caption).foregroundStyle(.secondary).lineLimit(3)
      }
    }
    .padding(10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .contentShape(Rectangle())
    .onTapGesture { showDetail = true }
    .help("Open the subagent conversation")
    .sheet(isPresented: $showDetail) {
      SubagentDetailView(run: run)
    }
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
      if isStreaming {
        ProgressView().controlSize(.small)
      } else {
        Image(systemName: "smallcircle.filled.circle").foregroundStyle(Theme.info)
      }
    default: Image(systemName: "circle").foregroundStyle(.tertiary)
    }
  }
}

private struct BtwCard: View {
  let question: String
  let answer: String
  @State private var expanded = true
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 6) {
        Image(systemName: "bubble.left.and.text.bubble.right").foregroundStyle(Theme.info)
        Text("by the way").fontWeight(.medium)
        Spacer()
        Text("not saved to the conversation")
          .font(.caption2).foregroundStyle(.tertiary)
      }
      Text(question).font(.callout).foregroundStyle(.secondary)
      Divider()
      MarkdownView(answer)
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Theme.info.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
    .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.info.opacity(0.25), lineWidth: 1))
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
    .background(
      Color(nsColor: .textBackgroundColor).opacity(0.5),
      in: RoundedRectangle(cornerRadius: 6))
  }
}

/// Public wrapper so the streaming overlay can render an in-flight tool call (ToolCallCard is private).
struct LiveToolRow: View {
  let name: String
  let args: [String: Any]
  let done: Bool
  let isError: Bool
  var body: some View {
    ToolCallCard(name: name, args: args, result: done ? "" : nil, isError: isError, running: !done)
  }
}
