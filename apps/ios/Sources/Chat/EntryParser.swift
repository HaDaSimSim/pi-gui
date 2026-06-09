import Foundation

// Converts session-file entries (scrollback) into ChatMessages. Ports the
// entriesToMessages logic from web/use-session.ts, including subagent-run and
// turn-meta custom entries and tool-result attachment.
enum EntryParser {
    static func messages(from entries: [JSONValue]) -> [ChatMessage] {
        var out: [ChatMessage] = []
        var subagentIdx: [String: Int] = [:]

        for e in entries {
            let type = e["type"]?.stringValue

            // subagent-run custom entry
            if type == "custom",
               e["customType"]?.stringValue == "subagent-run",
               let runId = e["data"]?["runId"]?.stringValue {
                let d = e["data"]!
                let view = subagentView(runId: runId, data: d)
                if let at = subagentIdx[runId] {
                    out[at].subagentRun = view
                } else {
                    subagentIdx[runId] = out.count
                    out.append(ChatMessage(key: e["id"]?.stringValue ?? runId, role: .subagent,
                                           text: "", time: e["timestamp"]?.stringValue, subagentRun: view))
                }
                continue
            }

            // turn-meta: attach elapsed to the previous assistant message
            if type == "custom_message", e["customType"]?.stringValue == "turn-meta",
               let elapsed = e["details"]?["elapsed"]?.numberValue {
                if let i = out.lastIndex(where: { $0.role == .assistant }) {
                    out[i].elapsedMs = elapsed * 1000
                    if out[i].model == nil, let m = e["details"]?["model"]?.stringValue { out[i].model = m }
                }
                continue
            }

            guard type == "message", let m = e["message"] else { continue }
            let role = m["role"]?.stringValue
            let id = e["id"]?.stringValue ?? UUID().uuidString
            let ts = e["timestamp"]?.stringValue

            switch role {
            case "bashExecution":
                out.append(ChatMessage(key: id, role: .bash, text: "", time: ts, bash: BashRunView(
                    command: m["command"]?.stringValue ?? "",
                    output: m["output"]?.stringValue ?? "",
                    exitCode: m["exitCode"]?.numberValue.map(Int.init),
                    cancelled: m["cancelled"]?.boolValue,
                    truncated: m["truncated"]?.boolValue,
                    excludeFromContext: m["excludeFromContext"]?.boolValue)))
            case "user":
                out.append(ChatMessage(key: id, role: .user, text: contentToText(m["content"]), time: ts))
            case "assistant":
                out.append(ChatMessage(key: id, role: .assistant,
                                       text: assistantText(m["content"]),
                                       thinking: thinkingText(m["content"]).nilIfEmpty,
                                       toolCalls: toolCalls(m["content"]).nilIfEmpty,
                                       model: m["model"]?.stringValue, time: ts))
            case "toolResult":
                if let i = out.lastIndex(where: { $0.role == .assistant && ($0.toolCalls?.isEmpty == false) }),
                   let callId = m["toolCallId"]?.stringValue,
                   var tcs = out[i].toolCalls,
                   let j = tcs.firstIndex(where: { $0.id == callId }) {
                    tcs[j].status = (m["isError"]?.boolValue == true) ? .error : .done
                    tcs[j].resultText = contentToText(m["content"])
                    out[i].toolCalls = tcs
                }
            default:
                break
            }
        }
        return out
    }

    static func subagentView(runId: String, data d: JSONValue) -> SubagentRunView {
        let turns: [SubagentTurn] = (d["turns"]?.arrayValue ?? []).map { tn in
            SubagentTurn(prompt: tn["prompt"]?.stringValue ?? "",
                         finalOutput: tn["finalOutput"]?.stringValue ?? "",
                         error: tn["error"]?.stringValue)
        }
        return SubagentRunView(runId: runId,
                               agent: d["agent"]?.stringValue ?? "",
                               title: d["title"]?.stringValue ?? "",
                               task: d["task"]?.stringValue ?? "",
                               status: d["status"]?.stringValue ?? "running",
                               model: d["model"]?.stringValue,
                               turns: turns,
                               cost: d["usage"]?["cost"]?.numberValue)
    }

    // ── content extractors ───────────────────────────────────────
    static func contentToText(_ content: JSONValue?) -> String {
        guard let content else { return "" }
        if let s = content.stringValue { return s }
        if let arr = content.arrayValue {
            return arr.filter { $0["type"]?.stringValue == "text" }
                      .compactMap { $0["text"]?.stringValue }.joined()
        }
        return ""
    }

    static func assistantText(_ content: JSONValue?) -> String { contentToText(content) }

    static func thinkingText(_ content: JSONValue?) -> String {
        guard let arr = content?.arrayValue else { return "" }
        return arr.filter { $0["type"]?.stringValue == "thinking" }
                  .compactMap { $0["thinking"]?.stringValue }.joined()
    }

    static func toolCalls(_ content: JSONValue?) -> [ToolCallView] {
        guard let arr = content?.arrayValue else { return [] }
        return arr.filter { $0["type"]?.stringValue == "toolCall" }.map { b in
            ToolCallView(id: b["id"]?.stringValue ?? UUID().uuidString,
                         name: b["name"]?.stringValue ?? "tool",
                         argsText: jsonText(b["arguments"]),
                         status: .done)
        }
    }

    static func jsonText(_ v: JSONValue?) -> String {
        guard let v else { return "" }
        if let s = v.stringValue { return s }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let data = try? encoder.encode(v), let s = String(data: data, encoding: .utf8) { return s }
        return ""
    }

    static func latestCustom(_ entries: [JSONValue], _ customType: String) -> JSONValue? {
        var found: JSONValue?
        for e in entries where e["type"]?.stringValue == "custom" && e["customType"]?.stringValue == customType {
            found = e["data"]
        }
        return found
    }
}

extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
extension Array {
    var nilIfEmpty: [Element]? { isEmpty ? nil : self }
}
