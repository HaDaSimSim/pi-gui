import PiCore
import SwiftUI

// Renders a single TranscriptItem. Messages.app aesthetic: user messages as trailing
// accent bubbles, assistant content left-aligned without a bubble background.
struct TranscriptItemView: View {
  let item: TranscriptItem
  let isStreaming: Bool

  var body: some View {
    switch item {
    case .user(_, let text, _):
      UserBubble(text: text)
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
  var body: some View {
    HStack {
      Spacer(minLength: 0)
      Text(text)
        .textSelection(.enabled)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(Color.accentColor, in: UserBubbleShape())
        .foregroundStyle(.white)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: 500, alignment: .trailing)
    }
    .frame(maxWidth: .infinity, alignment: .trailing)
  }
}

/// User bubble: 18pt rounded corners with a tighter tail on bottom-right.
private struct UserBubbleShape: Shape {
  func path(in rect: CGRect) -> Path {
    Path(
      roundedRect: rect,
      cornerRadii: RectangleCornerRadii(
        topLeading: 18, bottomLeading: 18, bottomTrailing: 4, topTrailing: 18))
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
      // Meta line below assistant text (elapsed time), like Messages.app metadata.
      if msg.elapsed != nil || msg.streaming {
        HStack(spacing: 6) {
          if let e = msg.elapsed {
            Text(Fmt.elapsed(e * 1000))
          }
          if msg.streaming {
            ProgressView().controlSize(.small)
              .accessibilityLabel("Working on response")
            Text("working…")
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
      Rectangle().fill(Theme.danger.opacity(0.8)).frame(height: 1)
      Text("interrupted").font(.caption2).foregroundStyle(Theme.danger)
      Rectangle().fill(Theme.danger.opacity(0.8)).frame(height: 1)
    }
    .padding(.vertical, 2)
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
      .contentShape(Rectangle())
      .onTapGesture { expanded.toggle() }
    }
    .disclosureGroupStyle(.automatic)
    .clipped()
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
  @State private var hovering = false

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
    DisclosureGroup(isExpanded: $expanded) {
      VStack(alignment: .leading, spacing: 6) {
        if !args.isEmpty {
          FullCodeBlock(text: argsJSONString, maxHeight: 300)
        }
        if let result {
          Text("result").font(.caption2).foregroundStyle(.tertiary)
          FullCodeBlock(text: result, maxHeight: 400)
        }
      }
      .padding(.top, 4)
      .frame(maxWidth: .infinity, alignment: .leading)
    } label: {
      HStack(spacing: 6) {
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
      }
      .contentShape(Rectangle())
      .onTapGesture { expanded.toggle() }
    }
    .disclosureGroupStyle(.automatic)
    .clipped()
    .padding(.horizontal, 8).padding(.vertical, 4)
    .background(
      hovering ? Color.secondary.opacity(0.14) : Color.secondary.opacity(0.08),
      in: RoundedRectangle(cornerRadius: 8)
    )
    .overlay(
      RoundedRectangle(cornerRadius: 8).stroke(Color(nsColor: .separatorColor), lineWidth: 1)
    )
    .animation(.easeInOut(duration: 0.2), value: expanded)
    .onHover { hovering = $0 }
    .animation(.easeOut(duration: 0.12), value: hovering)
  }

  private var argsJSONString: String {
    if let data = try? JSONSerialization.data(
      withJSONObject: args, options: [.prettyPrinted, .sortedKeys]),
      let str = String(data: data, encoding: .utf8)
    {
      return str
    }
    return "\(args)"
  }
}

private struct BashCard: View {
  let job: BashJobView
  @State private var expanded = true
  @State private var hovering = false
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
      .contentShape(Rectangle())
      .onTapGesture { expanded.toggle() }
    }
    .clipped()
    .animation(.easeInOut(duration: 0.2), value: expanded)
    .padding(8)
    .background(
      hovering ? Color.secondary.opacity(0.1) : Color.secondary.opacity(0.08),
      in: RoundedRectangle(cornerRadius: 8)
    )
    .onHover { hovering = $0 }
    .animation(.easeOut(duration: 0.12), value: hovering)
  }
}

private struct SubagentCard: View {
  let run: SubagentRun
  @State private var showDetail = false
  @State private var hovering = false
  private var color: Color {
    switch run.status {
    case "running": return Theme.streaming
    case "failed", "aborted": return Theme.danger
    default: return Theme.success
    }
  }
  var body: some View {
    Button {
      showDetail = true
    } label: {
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
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(run.title), \(run.status)")
    .accessibilityHint("Opens subagent conversation detail")
    .sheet(isPresented: $showDetail) {
      SubagentDetailView(run: run)
    }
    .background(
      hovering ? Color.secondary.opacity(0.1) : Color.secondary.opacity(0.08),
      in: RoundedRectangle(cornerRadius: 8)
    )
    .onHover { hovering = $0 }
    .animation(.easeOut(duration: 0.12), value: hovering)
  }
}

private struct TodoCard: View {
  let todos: [TodoItem]
  let isStreaming: Bool
  @State private var hovering = false
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
    .background(
      hovering ? Color.secondary.opacity(0.1) : Color.secondary.opacity(0.08),
      in: RoundedRectangle(cornerRadius: 8)
    )
    .onHover { hovering = $0 }
    .animation(.easeOut(duration: 0.12), value: hovering)
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
    .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
  }
}

/// Simple monospaced code box used for bash output (limited height, horizontal scroll).
struct CodeText: View {
  let text: String
  init(_ text: String) { self.text = text }
  var body: some View {
    ScrollView([.horizontal, .vertical], showsIndicators: true) {
      Text(text)
        .font(.system(.caption, design: .monospaced))
        .textSelection(.enabled)
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .frame(maxWidth: .infinity, maxHeight: 280, alignment: .leading)
    .background(
      Color(nsColor: .textBackgroundColor).opacity(0.5),
      in: RoundedRectangle(cornerRadius: 6)
    )
    .overlay(
      RoundedRectangle(cornerRadius: 6)
        .stroke(Color.secondary.opacity(0.15), lineWidth: 1))
  }
}

/// Full-content scrollable code block for tool call args/results. No truncation.
private struct FullCodeBlock: View {
  let text: String
  let maxHeight: CGFloat

  var body: some View {
    ScrollView([.horizontal, .vertical], showsIndicators: true) {
      Text(text)
        .font(.system(.caption, design: .monospaced))
        .textSelection(.enabled)
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }
    .frame(maxWidth: .infinity, maxHeight: maxHeight, alignment: .topLeading)
    .background(
      Color(nsColor: .textBackgroundColor),
      in: RoundedRectangle(cornerRadius: 6)
    )
    .overlay(
      RoundedRectangle(cornerRadius: 6)
        .stroke(Color.secondary.opacity(0.2), lineWidth: 1))
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
