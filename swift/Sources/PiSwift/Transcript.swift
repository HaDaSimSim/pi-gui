import Foundation

// Transcript model: turns session entries into renderable items, plus footer aggregation.
// Mirrors web/use-session.ts entriesToMessages, which is a LINEAR render (no parentId tree
// walk) — that's why tail-N reading is valid for scrollback.

enum TranscriptItem: Identifiable {
    case user(id: String, text: String, timestamp: Date?)
    case assistantText(id: String, text: String, timestamp: Date?, model: String?, elapsed: Double?)
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
        case .user(let id, _, _), .assistantText(let id, _, _, _, _), .thinking(let id, _),
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
    var turns: [SubagentTurn] = []
    var cost: Double = 0
    var error: String?
}

struct SubagentTurn: Identifiable {
    let index: Int
    let prompt: String
    let items: [SubagentTranscriptItem]
    let finalOutput: String
    let error: String?
    var id: Int { index }
}

struct SubagentTranscriptItem: Identifiable {
    let id = UUID()
    let kind: String          // thinking | text | toolCall | toolResult
    let text: String
    let toolName: String?
    let args: [String: Any]?
    let isError: Bool
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
                                    items.append(.assistantText(id: bid, text: t, timestamp: ts, model: model, elapsed: nil))
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
                        items.append(.assistantText(id: e.id ?? UUID().uuidString, text: text, timestamp: ts, model: model, elapsed: nil))
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
            case "custom_message":
                // turn-meta carries {elapsed, model} in details; attach to the previous
                // assistant text so each finished turn shows its elapsed time + model.
                if (e.raw["customType"] as? String) == "turn-meta",
                   let details = e.raw["details"] as? [String: Any],
                   let elapsed = details["elapsed"] as? Double {
                    for idx in stride(from: items.count - 1, through: 0, by: -1) {
                        if case .assistantText(let aid, let t, let ats, let m, _) = items[idx] {
                            items[idx] = .assistantText(id: aid, text: t, timestamp: ats,
                                                        model: (details["model"] as? String) ?? m,
                                                        elapsed: elapsed)
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
        return items
    }

    private static func buildCustom(_ e: SessionEntry) -> TranscriptItem? {
        guard let ct = e.raw["customType"] as? String,
              let data = e.raw["data"] as? [String: Any] else { return nil }
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
                return SubagentTurn(index: i, prompt: (t["prompt"] as? String) ?? "",
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
                error: data["error"] as? String
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
        for e in entries { accumulateFooter(e.raw, into: &s) }
        return s
    }

    /// Fold one raw entry's contribution into footer stats. Shared by footer(from:) and the
    /// streaming fullFooter() so totals match whether we parse a window or the whole file.
    static func accumulateFooter(_ raw: [String: Any], into s: inout FooterStats) {
        switch raw["type"] as? String {
        case "message":
            guard let msg = raw["message"] as? [String: Any],
                  (msg["role"] as? String) == "assistant",
                  let usage = msg["usage"] as? [String: Any] else { return }
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
                  let data = raw["data"] as? [String: Any] else { return }
            if ct == "todo-list", let todos = data["todos"] as? [[String: Any]] {
                s.todosTotal = todos.count
                s.todosDone = todos.filter { ($0["status"] as? String) == "completed" }.count
            } else if ct == "goal-state" {
                s.goalStatus = data["status"] as? String
            }
        default: break
        }
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
