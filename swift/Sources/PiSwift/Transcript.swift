import Foundation

// Transcript model: turns session entries into renderable items, plus footer aggregation.
// Mirrors web/use-session.ts entriesToMessages, which is a LINEAR render (no parentId tree
// walk) — that's why tail-N reading is valid for scrollback.

enum TranscriptItem: Identifiable {
    case user(id: String, text: String, timestamp: Date?)
    case assistantText(id: String, text: String, timestamp: Date?, model: String?)
    case thinking(id: String, text: String)
    case toolCall(id: String, name: String, args: [String: Any], result: String?, isError: Bool)
    case bashJob(id: String, label: String, command: String, status: String, output: String)
    case subagentRun(id: String, run: SubagentRun)
    case todoList(id: String, todos: [TodoItem])
    case goalState(id: String, objective: String, status: String)
    case btwAnswer(id: String, question: String, answer: String)
    case notice(id: String, text: String)   // model_change, compaction, etc.

    var id: String {
        switch self {
        case .user(let id, _, _), .assistantText(let id, _, _, _), .thinking(let id, _),
             .toolCall(let id, _, _, _, _), .bashJob(let id, _, _, _, _),
             .subagentRun(let id, _), .todoList(let id, _), .goalState(let id, _, _),
             .btwAnswer(let id, _, _),
             .notice(let id, _):
            return id
        }
    }
}

struct TodoItem: Identifiable, Hashable {
    let content: String
    let status: String        // pending | in_progress | completed
    let activeForm: String?
    var id: String { content }
}

struct SubagentRun {
    let runId: String
    let title: String
    let task: String
    let agent: String?
    let model: String?
    let status: String        // running | completed | failed | aborted
    let sessionDir: String?
    let sessionId: String?
    let startedAt: Date?
}

struct FooterStats {
    var inputTokens = 0
    var outputTokens = 0
    var cacheRead = 0
    var cacheWrite = 0
    var totalTokens = 0
    var cost = 0.0
    var contextTokens = 0
    var contextWindow = 0
    var model: String?
    var todosDone = 0
    var todosTotal = 0
    var goalStatus: String?
}

struct Transcript {

    /// Build a linear list of renderable items from raw entries. Foreign custom entries are
    /// shape-guarded (pi has no extension namespacing — customType is a flat global string).
    static func build(from entries: [SessionEntry], hideThinking: Bool) -> [TranscriptItem] {
        var items: [TranscriptItem] = []
        // Collect tool results so a toolCall can show its result inline.
        var toolResults: [String: (text: String, isError: Bool)] = [:]
        for e in entries where e.type == "message" {
            guard let msg = e.raw["message"] as? [String: Any],
                  (msg["role"] as? String) == "toolResult",
                  let callId = msg["toolCallId"] as? String else { continue }
            toolResults[callId] = (SessionStore.extractText(msg["content"]) ?? "", (msg["isError"] as? Bool) ?? false)
        }

        for e in entries {
            let ts = parseDate(e.timestamp)
            switch e.type {
            case "message":
                guard let msg = e.raw["message"] as? [String: Any],
                      let role = msg["role"] as? String else { continue }
                switch role {
                case "user":
                    if let text = SessionStore.extractText(msg["content"]), !text.isEmpty {
                        items.append(.user(id: e.id ?? UUID().uuidString, text: text, timestamp: ts))
                    }
                case "assistant":
                    let model = msg["model"] as? String
                    if let blocks = msg["content"] as? [[String: Any]] {
                        for (i, block) in blocks.enumerated() {
                            let bid = (e.id ?? UUID().uuidString) + "#\(i)"
                            switch block["type"] as? String {
                            case "text":
                                if let t = block["text"] as? String, !t.isEmpty {
                                    items.append(.assistantText(id: bid, text: t, timestamp: ts, model: model))
                                }
                            case "thinking":
                                if !hideThinking, let t = block["thinking"] as? String, !t.isEmpty {
                                    items.append(.thinking(id: bid, text: t))
                                }
                            case "toolCall":
                                let name = (block["name"] as? String) ?? "tool"
                                let args = (block["arguments"] as? [String: Any]) ?? [:]
                                let callId = (block["id"] as? String) ?? bid
                                let res = toolResults[callId]
                                items.append(.toolCall(id: bid, name: name, args: args,
                                                       result: res?.text, isError: res?.isError ?? false))
                            default: break
                            }
                        }
                    } else if let text = SessionStore.extractText(msg["content"]), !text.isEmpty {
                        items.append(.assistantText(id: e.id ?? UUID().uuidString, text: text, timestamp: ts, model: model))
                    }
                case "toolResult":
                    break // surfaced inline with the toolCall
                case "bashExecution":
                    let cmd = (msg["command"] as? String) ?? ""
                    let out = (msg["output"] as? String) ?? ""
                    items.append(.bashJob(id: e.id ?? UUID().uuidString, label: "bash", command: cmd, status: "done", output: out))
                default: break
                }
            case "custom":
                if let item = buildCustom(e) { items.append(item) }
            case "model_change":
                let mid = (e.raw["modelId"] as? String) ?? "?"
                items.append(.notice(id: e.id ?? UUID().uuidString, text: "Model → \(mid)"))
            default:
                break
            }
        }
        return items
    }

    private static func buildCustom(_ e: SessionEntry) -> TranscriptItem? {
        guard let ct = e.raw["customType"] as? String,
              let data = e.raw["data"] as? [String: Any] else { return nil }
        let id = e.id ?? UUID().uuidString
        switch ct {
        case "subagent-run":
            guard let runId = data["runId"] as? String else { return nil }
            let run = SubagentRun(
                runId: runId,
                title: (data["title"] as? String) ?? "subagent",
                task: (data["task"] as? String) ?? "",
                agent: data["agent"] as? String,
                model: data["model"] as? String,
                status: (data["status"] as? String) ?? "running",
                sessionDir: data["sessionDir"] as? String,
                sessionId: data["sessionId"] as? String,
                startedAt: (data["startedAt"] as? Double).map { Date(timeIntervalSince1970: $0 / 1000) }
            )
            return .subagentRun(id: id, run: run)
        case "todo-list":
            guard let todos = data["todos"] as? [[String: Any]] else { return nil }
            let parsed = todos.map { TodoItem(
                content: ($0["content"] as? String) ?? "",
                status: ($0["status"] as? String) ?? "pending",
                activeForm: $0["activeForm"] as? String
            ) }
            return .todoList(id: id, todos: parsed)
        case "goal-state":
            guard let obj = data["objective"] as? String else { return nil }
            return .goalState(id: id, objective: obj, status: (data["status"] as? String) ?? "")
        case "btw-answer":
            guard let q = data["question"] as? String, let a = data["answer"] as? String else { return nil }
            return .btwAnswer(id: id, question: q, answer: a)
        case "bash-job":
            guard let jobId = data["jobId"] as? String else { return nil }
            return .bashJob(
                id: id,
                label: (data["label"] as? String) ?? jobId,
                command: (data["command"] as? String) ?? "",
                status: (data["status"] as? String) ?? "running",
                output: (data["output"] as? String) ?? ""
            )
        default:
            return nil  // ignore unknown foreign custom entries
        }
    }

    /// Footer aggregation: sum assistant usage, take the latest todo-list/goal-state snapshot,
    /// and the most recent model. Mirrors the server footer route.
    static func footer(from entries: [SessionEntry]) -> FooterStats {
        var s = FooterStats()
        for e in entries {
            switch e.type {
            case "message":
                guard let msg = e.raw["message"] as? [String: Any],
                      (msg["role"] as? String) == "assistant",
                      let usage = msg["usage"] as? [String: Any] else { continue }
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
                if let m = e.raw["modelId"] as? String { s.model = m }
            case "custom":
                guard let ct = e.raw["customType"] as? String,
                      let data = e.raw["data"] as? [String: Any] else { continue }
                if ct == "todo-list", let todos = data["todos"] as? [[String: Any]] {
                    s.todosTotal = todos.count
                    s.todosDone = todos.filter { ($0["status"] as? String) == "completed" }.count
                } else if ct == "goal-state" {
                    s.goalStatus = data["status"] as? String
                }
            default: break
            }
        }
        return s
    }

    static func parseDate(_ s: String?) -> Date? {
        guard let s else { return nil }
        return ISO8601DateFormatter.shared.date(from: s)
    }
}

extension ISO8601DateFormatter {
    static let shared: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}
