import Foundation
import SwiftUI

// Live state of one session. Loads scrollback, subscribes to WS events, and
// accumulates streaming deltas — ports web/use-session.ts event handling.
@MainActor
final class SessionViewModel: ObservableObject {
    @Published var messages: [ChatMessage] = []
    @Published var streaming = false
    @Published var live = false
    @Published var loading = true
    @Published var error: String?
    @Published var name: String?
    @Published var controls: SessionControls?
    @Published var uiRequest: UiRequest?
    @Published var todo: [TodoItemView] = []
    @Published var goal: GoalStateView?
    @Published var conflict: LockConflict?
    @Published var queue: (steering: [String], followUp: [String]) = ([], [])
    @Published var footer: FooterData?

    let session: SessionInfo
    private let cwd: String?
    private let api: APIClient
    private let bus: EventBus
    var apiRef: APIClient { api }

    private var streamingMsg: ChatMessage?
    private var turnStart: Date?
    private var interrupted = false

    init(session: SessionInfo, cwd: String?, api: APIClient, bus: EventBus) {
        self.session = session
        self.cwd = cwd
        self.api = api
        self.bus = bus
    }

    var path: String { session.path }

    func start() async {
        await load()
        await bus.subscribe(path: path) { [weak self] event in
            Task { @MainActor in self?.handle(event) }
        }
    }

    func stop() {
        Task { await bus.unsubscribeAll(path: path) }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            let detail = try await api.sessionDetail(path: path)
            messages = EntryParser.messages(from: detail.entries)
            live = detail.live
            name = detail.name
            if let td = EntryParser.latestCustom(detail.entries, "todo-list")?["todos"]?.arrayValue {
                todo = td.map { TodoItemView(content: $0["content"]?.stringValue ?? "",
                                             activeForm: $0["activeForm"]?.stringValue,
                                             status: $0["status"]?.stringValue ?? "pending") }
            }
            if let g = EntryParser.latestCustom(detail.entries, "goal-state"),
               g["cleared"]?.boolValue != true, let obj = g["objective"]?.stringValue {
                goal = GoalStateView(objective: obj, status: g["status"]?.stringValue ?? "pursuing",
                                     iteration: Int(g["iteration"]?.numberValue ?? 0))
            }
            await refreshControls()
        } catch {
            self.error = error.localizedDescription
        }
    }

    func refreshControls() async {
        if let c = try? await api.controls(path: path) {
            controls = c
            if let n = c.name { name = n }
            if let q = c.queue { queue = (q.steering, q.followUp) }
        }
        // Footer (tokens/cost/context) aggregates from the file even without a runtime.
        footer = try? await api.footer(path: path, cwd: cwd)
    }

    // ── Event handling (mirrors use-session.ts handleEvent) ──────────
    private func handle(_ ev: JSONValue) {
        guard let type = ev["type"]?.stringValue else { return }
        switch type {
        case "_connected":
            live = ev["live"]?.boolValue ?? live
            streaming = ev["streaming"]?.boolValue ?? false

        case "agent_start":
            streaming = true
            turnStart = Date()

        case "message_start":
            if ev["message"]?["role"]?.stringValue == "assistant" {
                streamingMsg = ChatMessage(key: "stream-\(Date().timeIntervalSince1970)",
                                           role: .assistant, text: "", streaming: true,
                                           time: ISO8601DateFormatter().string(from: Date()))
                flushStreaming()
            } else if ev["message"]?["role"]?.stringValue == "user" {
                let text = EntryParser.contentToText(ev["message"]?["content"]).trimmingCharacters(in: .whitespacesAndNewlines)
                if !text.isEmpty {
                    // de-dupe trailing user run
                    var dup = false
                    for m in messages.reversed() {
                        if m.role == .assistant { break }
                        if m.role == .user && m.text == text { dup = true; break }
                    }
                    if !dup {
                        messages.append(ChatMessage(key: "u-\(Date().timeIntervalSince1970)", role: .user, text: text,
                                                    time: ISO8601DateFormatter().string(from: Date())))
                    }
                }
            }

        case "message_update":
            let d = ev["assistantMessageEvent"]
            var sm = streamingMsg ?? ChatMessage(key: "stream-\(Date().timeIntervalSince1970)", role: .assistant, text: "", streaming: true)
            let dt = d?["type"]?.stringValue
            if dt == "text_delta" {
                sm.text += d?["delta"]?.stringValue ?? ""
            } else if dt == "thinking_delta" {
                sm.thinking = (sm.thinking ?? "") + (d?["delta"]?.stringValue ?? "")
            } else if dt == "toolcall_end", let tc = d?["toolCall"] {
                var calls = sm.toolCalls ?? []
                calls.append(ToolCallView(id: tc["id"]?.stringValue ?? UUID().uuidString,
                                          name: tc["name"]?.stringValue ?? "tool",
                                          argsText: EntryParser.jsonText(tc["arguments"]), status: .running))
                sm.toolCalls = calls
            }
            streamingMsg = sm
            flushStreaming()

        case "tool_execution_start":
            updateToolCall(ev["toolCallId"]?.stringValue, name: ev["toolName"]?.stringValue,
                           args: ev["args"], status: .running, result: nil, create: true)
        case "tool_execution_update":
            updateToolCall(ev["toolCallId"]?.stringValue, status: .running,
                           result: EntryParser.contentToText(ev["partialResult"]?["content"]))
        case "tool_execution_end":
            updateToolCall(ev["toolCallId"]?.stringValue,
                           status: ev["isError"]?.boolValue == true ? .error : .done,
                           result: EntryParser.contentToText(ev["result"]?["content"]))

        case "message_end":
            if var sm = streamingMsg {
                sm.streaming = false
                if let stop = ev["message"]?["stopReason"]?.stringValue, stop == "aborted" || stop == "error" {
                    sm.errorMessage = ev["message"]?["errorMessage"]?.stringValue ?? (stop == "aborted" ? "Operation aborted" : "Error")
                }
                streamingMsg = sm
                flushStreaming()
                streamingMsg = nil
            }

        case "agent_end":
            if streamingMsg != nil { flushStreaming(); streamingMsg = nil }
            // drop trailing empty assistant
            while let last = messages.last, last.role == .assistant, last.text.trimmingCharacters(in: .whitespaces).isEmpty,
                  last.thinking == nil, (last.toolCalls?.isEmpty ?? true), last.subagentRun == nil {
                messages.removeLast()
            }
            if let i = messages.lastIndex(where: { $0.role == .assistant }) {
                if let start = turnStart { messages[i].elapsedMs = Date().timeIntervalSince(start) * 1000 }
                if interrupted { messages[i].interrupted = true }
            }
            interrupted = false
            streaming = false
            turnStart = nil
            Task { await refreshControls() }

        case "session_error":
            streaming = false
            error = ev["message"]?.stringValue ?? "session error"
            streamingMsg = nil

        case "todo":
            if let td = ev["state"]?["todos"]?.arrayValue {
                todo = td.map { TodoItemView(content: $0["content"]?.stringValue ?? "",
                                             activeForm: $0["activeForm"]?.stringValue,
                                             status: $0["status"]?.stringValue ?? "pending") }
            } else { todo = [] }

        case "goal":
            if let g = ev["state"], let obj = g["objective"]?.stringValue {
                goal = GoalStateView(objective: obj, status: g["status"]?.stringValue ?? "pursuing",
                                     iteration: Int(g["iteration"]?.numberValue ?? 0))
            } else { goal = nil }

        case "session_info_changed":
            if let n = ev["name"]?.stringValue { name = n }

        case "queue_update":
            queue = (ev["steering"]?.arrayValue?.compactMap { $0.stringValue } ?? [],
                     ev["followUp"]?.arrayValue?.compactMap { $0.stringValue } ?? [])

        case "subagent_runs":
            if let runs = ev["runs"]?.arrayValue {
                for r in runs {
                    guard let runId = r["runId"]?.stringValue else { continue }
                    let view = EntryParser.subagentView(runId: runId, data: r)
                    if let i = messages.firstIndex(where: { $0.subagentRun?.runId == runId }) {
                        messages[i].subagentRun = view
                    } else {
                        messages.append(ChatMessage(key: "subagent-\(runId)", role: .subagent, text: "",
                                                    time: ISO8601DateFormatter().string(from: Date()), subagentRun: view))
                    }
                }
            }

        case "ui_request":
            uiRequest = UiRequest(id: ev["id"]?.stringValue ?? "",
                                  kind: ev["kind"]?.stringValue ?? "confirm",
                                  title: ev["title"]?.stringValue ?? "",
                                  message: ev["message"]?.stringValue,
                                  placeholder: ev["placeholder"]?.stringValue,
                                  options: ev["options"]?.arrayValue?.compactMap { $0.stringValue },
                                  questions: parseQuestions(ev["questions"]),
                                  answer: ev["answer"]?.stringValue)
        case "ui_cancel":
            if uiRequest?.id == ev["id"]?.stringValue { uiRequest = nil }

        case "user_bash_start":
            messages.append(ChatMessage(key: ev["runId"]?.stringValue ?? UUID().uuidString, role: .bash, text: "",
                                        time: ISO8601DateFormatter().string(from: Date()),
                                        bash: BashRunView(command: ev["command"]?.stringValue ?? "", output: "",
                                                          excludeFromContext: ev["excludeFromContext"]?.boolValue, running: true)))
        case "user_bash_output":
            if let i = messages.firstIndex(where: { $0.key == ev["runId"]?.stringValue }), var b = messages[i].bash {
                b.output += ev["chunk"]?.stringValue ?? ""
                messages[i].bash = b
            }
        case "user_bash_end":
            if let i = messages.firstIndex(where: { $0.key == ev["runId"]?.stringValue }) {
                messages[i].bash = BashRunView(command: ev["command"]?.stringValue ?? messages[i].bash?.command ?? "",
                                               output: ev["output"]?.stringValue ?? messages[i].bash?.output ?? "",
                                               exitCode: ev["exitCode"]?.numberValue.map(Int.init),
                                               cancelled: ev["cancelled"]?.boolValue,
                                               truncated: ev["truncated"]?.boolValue,
                                               excludeFromContext: ev["excludeFromContext"]?.boolValue, running: false)
            }

        default:
            break
        }
    }

    private func parseQuestions(_ v: JSONValue?) -> [UiQuestion]? {
        guard let arr = v?.arrayValue else { return nil }
        return arr.map { q in
            UiQuestion(id: q["id"]?.stringValue ?? UUID().uuidString,
                       label: q["label"]?.stringValue ?? "",
                       prompt: q["prompt"]?.stringValue ?? "",
                       options: (q["options"]?.arrayValue ?? []).map {
                           UiQuestionOption(value: $0["value"]?.stringValue ?? "",
                                            label: $0["label"]?.stringValue ?? "",
                                            description: $0["description"]?.stringValue)
                       },
                       multiSelect: q["multiSelect"]?.boolValue ?? false)
        }
    }

    private func flushStreaming() {
        guard let sm = streamingMsg else { return }
        if let i = messages.firstIndex(where: { $0.key == sm.key }) { messages[i] = sm }
        else { messages.append(sm) }
    }

    private func updateToolCall(_ id: String?, name: String? = nil, args: JSONValue? = nil,
                                status: ToolCallView.Status, result: String?, create: Bool = false) {
        guard let id else { return }
        if streamingMsg != nil {
            var calls = streamingMsg?.toolCalls ?? []
            if let j = calls.firstIndex(where: { $0.id == id }) {
                calls[j].status = status
                if let result { calls[j].resultText = result }
                streamingMsg?.toolCalls = calls
                flushStreaming()
                return
            } else if create {
                calls.append(ToolCallView(id: id, name: name ?? "tool", argsText: EntryParser.jsonText(args),
                                          status: status, resultText: result))
                streamingMsg?.toolCalls = calls
                flushStreaming()
                return
            }
        }
        // committed messages
        for i in stride(from: messages.count - 1, through: 0, by: -1) {
            guard messages[i].role == .assistant, var calls = messages[i].toolCalls else { continue }
            if let j = calls.firstIndex(where: { $0.id == id }) {
                calls[j].status = status
                if let result { calls[j].resultText = result }
                messages[i].toolCalls = calls
                return
            }
        }
        if create, let i = messages.lastIndex(where: { $0.role == .assistant }) {
            var calls = messages[i].toolCalls ?? []
            calls.append(ToolCallView(id: id, name: name ?? "tool", argsText: EntryParser.jsonText(args),
                                      status: status, resultText: result))
            messages[i].toolCalls = calls
        }
    }

    // ── Actions ──────────────────────────────────────────────────
    func send(_ text: String, deliverAs: String? = nil) async {
        conflict = nil; error = nil
        if deliverAs == nil {
            messages.append(ChatMessage(key: "u-\(Date().timeIntervalSince1970)", role: .user, text: text,
                                        time: ISO8601DateFormatter().string(from: Date())))
        }
        do {
            try await api.prompt(path: path, message: text, cwd: cwd, deliverAs: deliverAs)
            live = true
            await refreshControls()
        } catch let e as APIError {
            handleActionError(e)
        } catch {
            self.error = error.localizedDescription
        }
    }

    func abort() async {
        interrupted = true
        try? await api.abort(path: path)
    }

    func setModel(provider: String, id: String) async {
        if let c = try? await api.setModel(path: path, provider: provider, id: id) { controls = c }
    }
    func setThinking(_ level: String) async {
        if let c = try? await api.setThinking(path: path, level: level) { controls = c }
    }
    func rename(_ newName: String) async {
        if let c = try? await api.rename(path: path, name: newName) { controls = c; name = c.name }
    }
    func respondUi(id: String, value: JSONValue) async {
        uiRequest = nil
        try? await api.uiResponse(path: path, id: id, value: value)
    }
    func editQueue(steering: [String], followUp: [String]) async {
        queue = (steering, followUp)
        try? await api.setQueue(path: path, steering: steering, followUp: followUp)
    }
    func takeover(resend: String?) async {
        do {
            try await api.open(path: path, force: true)
            conflict = nil
            await refreshControls()
            if let resend { await send(resend) }
        } catch { self.error = error.localizedDescription }
    }

    private func handleActionError(_ e: APIError) {
        if case .http(let code, let body) = e, code == 409 {
            let kind = body.contains("revoked") ? "revoked" : "locked"
            conflict = LockConflict(kind: kind)
        } else {
            error = e.localizedDescription
        }
    }
}
