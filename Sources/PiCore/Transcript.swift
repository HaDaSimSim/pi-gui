import Foundation

// Transcript model: turns session entries into renderable items, plus footer aggregation.
// Mirrors web/use-session.ts entriesToMessages, which is a LINEAR render (no parentId tree
// walk) — that's why tail-N reading is valid for scrollback.

public enum TranscriptItem: Identifiable {
  case user(id: String, text: String, timestamp: Date?)
  case assistant(id: String, msg: AssistantMessage)
  case bashJob(id: String, job: BashJobView)
  case subagentRun(id: String, run: SubagentRun)
  case todoList(id: String, todos: [TodoItem])
  case goalState(id: String, objective: String, status: String)
  case btwAnswer(id: String, question: String, answer: String)
  case notice(id: String, text: String)  // model_change, compaction, etc.

  public var id: String {
    switch self {
    case .user(let id, _, _), .assistant(let id, _),
      .bashJob(let id, _),
      .subagentRun(let id, _), .todoList(let id, _), .goalState(let id, _, _),
      .btwAnswer(let id, _, _),
      .notice(let id, _):
      return id
    }
  }
}

/// One assistant turn, grouped like the web's ChatMessage: text + thinking + tool calls, with
/// meta (elapsed only on a finished turn), interrupted, and error flags.
public struct AssistantMessage {
  public var text: String
  public var thinking: String?
  public var toolCalls: [ToolCallView]
  public var model: String?
  public var timestamp: Date?
  public var elapsed: Double?  // seconds; set only when the turn finished (turn-meta)
  public var interrupted: Bool
  public var errorMessage: String?
  public var streaming: Bool  // true while this message is still being streamed (live overlay)

  public init(
    text: String, thinking: String?, toolCalls: [ToolCallView], model: String?,
    timestamp: Date?, elapsed: Double?, interrupted: Bool = false,
    errorMessage: String? = nil, streaming: Bool = false
  ) {
    self.text = text
    self.thinking = thinking
    self.toolCalls = toolCalls
    self.model = model
    self.timestamp = timestamp
    self.elapsed = elapsed
    self.interrupted = interrupted
    self.errorMessage = errorMessage
    self.streaming = streaming
  }
}

public struct ToolCallView: Identifiable {
  public let id: String
  public let name: String
  public let args: [String: Any]
  public var status: String  // running | done | error | unknown
  public var resultText: String?

  public init(id: String, name: String, args: [String: Any], status: String, resultText: String?) {
    self.id = id
    self.name = name
    self.args = args
    self.status = status
    self.resultText = resultText
  }
}

/// A user `!`/`!!` bash command (or an async-bash job), with the fields BashCard needs to
/// reflect failed/cancelled/truncated/no-context states. Mirrors web BashRunView.
public struct BashJobView {
  public let label: String
  public let command: String
  public var status: String  // running | done | failed | cancelled
  public let output: String
  public var exitCode: Int?
  public var cancelled: Bool
  public var truncated: Bool
  public var excludeFromContext: Bool

  public init(
    label: String, command: String, status: String, output: String,
    exitCode: Int? = nil, cancelled: Bool = false, truncated: Bool = false,
    excludeFromContext: Bool = false
  ) {
    self.label = label
    self.command = command
    self.status = status
    self.output = output
    self.exitCode = exitCode
    self.cancelled = cancelled
    self.truncated = truncated
    self.excludeFromContext = excludeFromContext
  }
}

public struct TodoItem: Identifiable, Hashable {
  public let content: String
  public let status: String  // pending | in_progress | completed
  public let activeForm: String?
  public var id: String { "\(status):\(content)" }

  public init(content: String, status: String, activeForm: String?) {
    self.content = content
    self.status = status
    self.activeForm = activeForm
  }
}

public struct SubagentRun {
  public let runId: String
  public let title: String
  public let task: String
  public let agent: String?
  public let model: String?
  public let status: String  // running | completed | failed | aborted
  public let sessionDir: String?
  public let sessionId: String?
  public let startedAt: Date?
  public var turns: [SubagentTurn]
  public var cost: Double
  public var error: String?
  public var batchId: String?
  public var stale: Bool  // persisted 'running' that hasn't updated in a long time

  public init(
    runId: String, title: String, task: String, agent: String?, model: String?,
    status: String, sessionDir: String?, sessionId: String?, startedAt: Date?,
    turns: [SubagentTurn] = [], cost: Double = 0, error: String? = nil,
    batchId: String? = nil, stale: Bool = false
  ) {
    self.runId = runId
    self.title = title
    self.task = task
    self.agent = agent
    self.model = model
    self.status = status
    self.sessionDir = sessionDir
    self.sessionId = sessionId
    self.startedAt = startedAt
    self.turns = turns
    self.cost = cost
    self.error = error
    self.batchId = batchId
    self.stale = stale
  }
}

public struct SubagentTurn: Identifiable {
  public let index: Int
  public let prompt: String
  public let items: [SubagentTranscriptItem]
  public let finalOutput: String
  public let error: String?
  public var id: Int { index }

  public init(
    index: Int, prompt: String, items: [SubagentTranscriptItem], finalOutput: String, error: String?
  ) {
    self.index = index
    self.prompt = prompt
    self.items = items
    self.finalOutput = finalOutput
    self.error = error
  }
}

public struct SubagentTranscriptItem: Identifiable {
  public let id: String
  public let kind: String  // thinking | text | toolCall | toolResult
  public let text: String
  public let toolName: String?
  public let args: [String: Any]?
  public let isError: Bool

  public init(
    kind: String, text: String, toolName: String? = nil, args: [String: Any]? = nil,
    isError: Bool = false
  ) {
    self.id = "\(kind)-\(text.prefix(32).hashValue)"
    self.kind = kind
    self.text = text
    self.toolName = toolName
    self.args = args
    self.isError = isError
  }
}

public struct Transcript {

  /// Build a linear list of renderable items from raw entries. Foreign custom entries are
  /// shape-guarded (pi has no extension namespacing — customType is a flat global string).
  public static func build(
    from entries: [SessionEntry], hideThinking: Bool, liveCallIds: Set<String> = []
  )
    -> [TranscriptItem]
  {
    var items: [TranscriptItem] = []
    // Collect tool results so a toolCall can show its result inline.
    var toolResults: [String: (text: String, isError: Bool)] = [:]
    // Subagent-run dedup: track first-occurrence index and latest snapshot per runId.
    var subagentFirstIndex: [String: Int] = [:]  // runId → index in items
    var subagentLatest: [String: TranscriptItem] = [:]  // runId → latest item
    for e in entries where e.type == "message" {
      guard let msg = e.raw["message"] as? [String: Any],
        (msg["role"] as? String) == "toolResult",
        let callId = msg["toolCallId"] as? String
      else { continue }
      toolResults[callId] = (
        SessionStore.extractText(msg["content"]) ?? "", (msg["isError"] as? Bool) ?? false
      )
    }

    for e in entries {
      let ts = parseDate(e.timestamp)
      switch e.type {
      case "message":
        guard let msg = e.raw["message"] as? [String: Any],
          let role = msg["role"] as? String
        else { continue }
        switch role {
        case "user":
          if let text = SessionStore.extractText(msg["content"]), !text.isEmpty {
            items.append(.user(id: e.id ?? UUID().uuidString, text: text, timestamp: ts))
          }
        case "assistant":
          let model = msg["model"] as? String
          var text = ""
          var thinking = ""
          var toolCalls: [ToolCallView] = []
          if let blocks = msg["content"] as? [[String: Any]] {
            for block in blocks {
              switch block["type"] as? String {
              case "text": if let t = block["text"] as? String { text += t }
              case "thinking": if let t = block["thinking"] as? String { thinking += t }
              case "toolCall":
                let callId = (block["id"] as? String) ?? UUID().uuidString
                let res = toolResults[callId]
                let status: String
                if let res {
                  status = res.isError ? "error" : "done"
                } else {
                  status = liveCallIds.contains(callId) ? "running" : "unknown"
                }
                toolCalls.append(
                  ToolCallView(
                    id: callId,
                    name: (block["name"] as? String) ?? "tool",
                    args: (block["arguments"] as? [String: Any]) ?? [:],
                    status: status,
                    resultText: res?.text))
              default: break
              }
            }
          } else if let t = SessionStore.extractText(msg["content"]) {
            text = t
          }
          let stop = msg["stopReason"] as? String
          let errMsg = msg["errorMessage"] as? String
          let am = AssistantMessage(
            text: text,
            thinking: (hideThinking || thinking.isEmpty) ? nil : thinking,
            toolCalls: toolCalls,
            model: model, timestamp: ts, elapsed: nil,
            interrupted: stop == "aborted",
            errorMessage: stop == "error" ? (errMsg ?? "Error") : nil)
          items.append(.assistant(id: e.id ?? UUID().uuidString, msg: am))
        case "toolResult":
          break  // surfaced inline with the toolCall
        case "bashExecution":
          let cmd = (msg["command"] as? String) ?? ""
          let out = (msg["output"] as? String) ?? ""
          let exit = msg["exitCode"] as? Int
          let cancelled = (msg["cancelled"] as? Bool) ?? false
          let status = cancelled ? "cancelled" : ((exit ?? 0) != 0 ? "failed" : "done")
          let job = BashJobView(
            label: "bash", command: cmd, status: status, output: out,
            exitCode: exit, cancelled: cancelled,
            truncated: (msg["truncated"] as? Bool) ?? false,
            excludeFromContext: (msg["excludeFromContext"] as? Bool) ?? false)
          items.append(.bashJob(id: e.id ?? UUID().uuidString, job: job))
        default: break
        }
      case "custom":
        if let item = buildCustom(e) {
          if case .subagentRun(_, let run) = item {
            let runId = run.runId
            if let existingIdx = subagentFirstIndex[runId] {
              subagentLatest[runId] = item
              _ = existingIdx
            } else {
              subagentFirstIndex[runId] = items.count
              subagentLatest[runId] = item
              items.append(item)
            }
          } else {
            items.append(item)
          }
        }
      case "custom_message":
        if (e.raw["customType"] as? String) == "turn-meta",
          let details = e.raw["details"] as? [String: Any],
          let elapsed = details["elapsed"] as? Double
        {
          for idx in stride(from: items.count - 1, through: 0, by: -1) {
            if case .assistant(let aid, var am) = items[idx] {
              am.elapsed = elapsed
              if am.model == nil { am.model = details["model"] as? String }
              items[idx] = .assistant(id: aid, msg: am)
              break
            }
          }
        }
      case "model_change":
        let mid = (e.raw["modelId"] as? String) ?? "?"
        items.append(.notice(id: e.id ?? UUID().uuidString, text: "Model → \(mid)"))
      default:
        break
      }
    }
    // Post-pass: patch subagent-run items with the latest snapshot per runId.
    for (runId, idx) in subagentFirstIndex {
      if let latest = subagentLatest[runId] {
        items[idx] = latest
      }
    }
    return items
  }

  private static func buildCustom(_ e: SessionEntry) -> TranscriptItem? {
    guard let ct = e.raw["customType"] as? String,
      let data = e.raw["data"] as? [String: Any]
    else { return nil }
    let id = e.id ?? UUID().uuidString
    switch ct {
    case "subagent-run":
      guard let runId = data["runId"] as? String else { return nil }
      let turnsRaw = (data["turns"] as? [[String: Any]]) ?? []
      let turns: [SubagentTurn] = turnsRaw.enumerated().map { (i, t) in
        let items = ((t["transcript"] as? [[String: Any]]) ?? []).map { ti in
          SubagentTranscriptItem(
            kind: (ti["kind"] as? String) ?? "text",
            text: (ti["text"] as? String) ?? "",
            toolName: ti["toolName"] as? String,
            args: ti["args"] as? [String: Any],
            isError: (ti["isError"] as? Bool) ?? false)
        }
        return SubagentTurn(
          index: i, prompt: (t["prompt"] as? String) ?? "",
          items: items, finalOutput: (t["finalOutput"] as? String) ?? "",
          error: t["error"] as? String)
      }
      let usage = data["usage"] as? [String: Any]
      let run = SubagentRun(
        runId: runId,
        title: (data["title"] as? String) ?? "subagent",
        task: (data["task"] as? String) ?? "",
        agent: data["agent"] as? String,
        model: data["model"] as? String,
        status: (data["status"] as? String) ?? "running",
        sessionDir: data["sessionDir"] as? String,
        sessionId: data["sessionId"] as? String,
        startedAt: (data["startedAt"] as? Double).map { Date(timeIntervalSince1970: $0 / 1000) },
        turns: turns,
        cost: (usage?["cost"] as? Double) ?? 0,
        error: data["error"] as? String,
        batchId: data["batchId"] as? String,
        stale: {
          guard (data["status"] as? String) == "running",
            let started = data["startedAt"] as? Double
          else { return false }
          return Date().timeIntervalSince1970 * 1000 - started > 90_000
        }()
      )
      return .subagentRun(id: id, run: run)
    case "todo-list":
      guard let todos = data["todos"] as? [[String: Any]] else { return nil }
      let parsed = todos.map {
        TodoItem(
          content: ($0["content"] as? String) ?? "",
          status: ($0["status"] as? String) ?? "pending",
          activeForm: $0["activeForm"] as? String
        )
      }
      return .todoList(id: id, todos: parsed)
    case "goal-state":
      guard let obj = data["objective"] as? String else { return nil }
      return .goalState(id: id, objective: obj, status: (data["status"] as? String) ?? "")
    case "btw-answer":
      guard let q = data["question"] as? String, let a = data["answer"] as? String else {
        return nil
      }
      return .btwAnswer(id: id, question: q, answer: a)
    case "bash-job":
      guard let jobId = data["jobId"] as? String else { return nil }
      let job = BashJobView(
        label: (data["label"] as? String) ?? jobId,
        command: (data["command"] as? String) ?? "",
        status: (data["status"] as? String) ?? "running",
        output: (data["output"] as? String) ?? "",
        exitCode: data["exitCode"] as? Int,
        cancelled: (data["cancelled"] as? Bool) ?? false,
        truncated: (data["truncated"] as? Bool) ?? false,
        excludeFromContext: (data["excludeFromContext"] as? Bool) ?? false)
      return .bashJob(id: id, job: job)
    default:
      return nil
    }
  }

  /// Footer aggregation: sum assistant usage, take the latest todo-list/goal-state snapshot,
  /// and the most recent model. Mirrors the server footer route.
  public static func footer(from entries: [SessionEntry]) -> FooterStats {
    var s = FooterStats()
    for e in entries { accumulateFooter(e.raw, into: &s) }
    return s
  }

  /// Fold one raw entry's contribution into footer stats. Shared by footer(from:) and the
  /// streaming fullFooter() so totals match whether we parse a window or the whole file.
  public static func accumulateFooter(_ raw: [String: Any], into s: inout FooterStats) {
    switch raw["type"] as? String {
    case "message":
      guard let msg = raw["message"] as? [String: Any],
        (msg["role"] as? String) == "assistant",
        let usage = msg["usage"] as? [String: Any]
      else { return }
      s.inputTokens += (usage["input"] as? Int) ?? 0
      s.outputTokens += (usage["output"] as? Int) ?? 0
      s.cacheRead += (usage["cacheRead"] as? Int) ?? 0
      s.cacheWrite += (usage["cacheWrite"] as? Int) ?? 0
      s.totalTokens += (usage["totalTokens"] as? Int) ?? 0
      if let cost = usage["cost"] as? [String: Any] {
        s.cost += (cost["total"] as? Double) ?? 0
      }
      if let m = msg["model"] as? String { s.model = m }
    case "model_change":
      if let m = raw["modelId"] as? String { s.model = m }
    case "custom":
      guard let ct = raw["customType"] as? String,
        let data = raw["data"] as? [String: Any]
      else { return }
      if ct == "todo-list", let todos = data["todos"] as? [[String: Any]] {
        s.todosTotal = todos.count
        s.todosDone = todos.filter { ($0["status"] as? String) == "completed" }.count
      } else if ct == "goal-state" {
        s.goalStatus = data["status"] as? String
      }
    default: break
    }
  }

  public static func parseDate(_ s: String?) -> Date? {
    guard let s else { return nil }
    return ISO8601DateFormatter.shared.date(from: s)
  }
}

extension ISO8601DateFormatter {
  public static let shared: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
  }()
}
