import Foundation
import Combine

// Runtime manager: ties an RpcClient to a SessionLock, mirroring server/runtime-manager.ts.
// One RuntimeSession per open/live session. The load-bearing rule from AGENTS.md moves here:
// lock.isMine() is re-checked before EVERY prompt send (pi won't enforce it under PI_WEB_HOST).

@MainActor
final class RuntimeSession: ObservableObject, RpcClientDelegate {
    let id = UUID()
    let cwd: String
    private(set) var sessionPath: String?

    // Live transcript built from streamed events (separate from the file-read scrollback).
    @Published var items: [TranscriptItem] = []
    @Published var streamingText: String = ""        // partial assistant text during streaming
    @Published var streamingThinking: String = ""
    @Published var isStreaming = false
    @Published var footer = FooterStats()
    @Published var model: String?
    @Published var thinkingLevel: String = "off"
    @Published var sessionName: String?
    @Published var lockStatus: LockUIStatus = .owned
    @Published var pendingDialog: PendingDialog?
    @Published var statusEntries: [String: String] = [:]   // statusKey -> text (ANSI stripped)
    @Published var notifications: [AppNotification] = []
    @Published var commands: [SlashCommand] = []

    private let rpc = RpcClient()
    private var lock: SessionLock?
    private let piPath: String
    private let model0: String?
    private let sessionDir: String?
    private(set) var isStarted = false

    /// For browse-only tabs: point at an existing session file without spawning pi.
    func setSessionPathForBrowsing(_ path: String) {
        sessionPath = path
    }

    /// Reload the committed transcript from the session file tail (OOM-safe). This is the
    /// source of truth for tool calls/results, todo/goal/subagent state, and final text.
    func reloadFromFile() {
        guard let path = sessionPath else { return }
        let sf = SessionFile(path: path)
        guard let entries = try? sf.tailEntries() else { return }
        items = Transcript.build(from: entries, hideThinking: false)
        footer = Transcript.footer(from: entries)
        if footer.model != nil { model = footer.model }
    }

    enum LockUIStatus: Equatable { case owned, readOnly, lost }

    init(cwd: String, piPath: String, model: String?, sessionDir: String?) {
        self.cwd = cwd
        self.piPath = piPath
        self.model0 = model
        self.sessionDir = sessionDir
    }

    func start() throws {
        guard !isStarted else { return }
        // If we're opening an existing session file, pass its dir so the new RPC writes there,
        // and switch_session to resume it (otherwise pi mints a brand-new session file).
        let resumePath = sessionPath
        let dir = resumePath.map { ($0 as NSString).deletingLastPathComponent } ?? sessionDir
        try rpc.start(piPath: piPath, cwd: cwd, model: model0, sessionDir: dir)
        rpc.delegate = self
        isStarted = true
        if let resumePath {
            rpc.switchSession(resumePath)
        }
        rpc.getState()
        rpc.getCommands()
        startLockWatch()
    }

    /// Acquire the host lock once we learn the session file path.
    private func ensureLock(for path: String) {
        if lock == nil {
            let l = SessionLock(sessionPath: path, owner: "pi-web", label: sessionName.map { "pi-gui: \($0)" } ?? "pi-gui")
            let r = l.tryAcquire()
            lock = l
            lockStatus = r.acquired ? .owned : .readOnly
        }
        // Flush a prompt that was issued before the session path/lock was known.
        if let p = pendingPrompt {
            pendingPrompt = nil
            sendPrompt(p)
        }
    }

    // MARK: - User actions (lock guard enforced here)

    func sendPrompt(_ text: String) {
        guard !text.isEmpty else { return }
        // If the session path/lock isn't established yet (state in flight), queue and send once
        // get_state arrives. This also ensures the lock guard below is meaningful.
        if sessionPath == nil && lock == nil {
            pendingPrompt = text
            return
        }
        // Load-bearing re-check: refuse to write if we no longer hold the lock.
        if let lock, !lock.isMine() {
            lockStatus = .lost
            notify("Lost the session lock — read-only.", type: "error")
            return
        }
        if isStreaming {
            rpc.prompt(text, streamingBehavior: "steer")
        } else {
            rpc.prompt(text)
        }
    }

    private var pendingPrompt: String?
    private var lockWatch: Timer?

    /// In-flight tool calls during the current streaming turn (cleared on agent_end reload).
    @Published var liveTools: [LiveTool] = []

    func abort() { rpc.abort() }
    func setModel(provider: String, modelId: String) { rpc.setModel(provider: provider, modelId: modelId) }

    // MARK: - Test support

    var sessionPathForTest: String? { sessionPath }
    private var onAgentEndOnce: (() -> Void)?

    /// Send a prompt and call back once the first agent_end fires. The prompt is auto-queued
    /// until the session path/lock is ready (see sendPrompt). Used by the headless self-test.
    func sendPromptWhenReady(_ text: String, completion: @escaping () -> Void) {
        onAgentEndOnce = completion
        sendPrompt(text)
    }
    func setThinking(_ level: String) { rpc.setThinkingLevel(level) }
    func rename(_ name: String) { sessionName = name; rpc.setSessionName(name) }
    func compact() { rpc.compact() }

    func takeover() {
        lock?.takeover()
        lockStatus = .owned
    }

    /// Periodically re-check lock ownership so a takeover by the TUI or another writer
    /// downgrades us to read-only in the UI even between prompts.
    private func startLockWatch() {
        lockWatch?.invalidate()
        let t = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, let lock = self.lock else { return }
                if lock.isLost(), self.lockStatus != .lost {
                    self.lockStatus = .lost
                    self.notify("Session taken over elsewhere — read-only.", type: "warning")
                }
            }
        }
        RunLoop.main.add(t, forMode: .common)
        lockWatch = t
    }

    func dispose() {
        lockWatch?.invalidate(); lockWatch = nil
        rpc.terminate()
        lock?.release()
        lock = nil
    }

    // MARK: - RpcClientDelegate

    nonisolated func rpc(_ client: RpcClient, didReceive incoming: RpcIncoming) {
        Task { @MainActor in self.handle(incoming) }
    }
    nonisolated func rpcDidExit(_ client: RpcClient, code: Int32) {
        Task { @MainActor in self.isStreaming = false }
    }

    private func handle(_ incoming: RpcIncoming) {
        switch incoming {
        case .response(_, let command, let success, let data, _):
            handleResponse(command: command, success: success, data: data)
        case .uiRequest(let req):
            handleUIRequest(req)
        case .event(let type, let raw):
            handleEvent(type: type, raw: raw)
        }
    }

    private func handleResponse(command: String, success: Bool, data: [String: Any]?) {
        switch command {
        case "get_state":
            if let data {
                if let m = data["model"] as? [String: Any] { model = m["id"] as? String }
                thinkingLevel = (data["thinkingLevel"] as? String) ?? thinkingLevel
                sessionName = data["sessionName"] as? String
                if let sf = data["sessionFile"] as? String {
                    sessionPath = sf
                    ensureLock(for: sf)
                }
            }
        case "get_commands":
            if let cmds = data?["commands"] as? [[String: Any]] {
                commands = cmds.compactMap { c in
                    guard let name = c["name"] as? String else { return nil }
                    return SlashCommand(name: name, description: c["description"] as? String,
                                        source: (c["source"] as? String) ?? "")
                }
            }
        case "get_session_stats":
            if let data { applyStats(data) }
        default:
            break
        }
    }

    private func applyStats(_ data: [String: Any]) {
        if let t = data["tokens"] as? [String: Any] {
            footer.inputTokens = (t["input"] as? Int) ?? footer.inputTokens
            footer.outputTokens = (t["output"] as? Int) ?? footer.outputTokens
            footer.totalTokens = (t["total"] as? Int) ?? footer.totalTokens
        }
        footer.cost = (data["cost"] as? Double) ?? footer.cost
        if let cu = data["contextUsage"] as? [String: Any] {
            footer.contextTokens = (cu["tokens"] as? Int) ?? 0
            footer.contextWindow = (cu["contextWindow"] as? Int) ?? 0
        }
    }

    private func handleEvent(type: String, raw: [String: Any]) {
        switch type {
        case "agent_start":
            isStreaming = true
            streamingText = ""
            streamingThinking = ""
        case "message_update":
            if let ame = raw["assistantMessageEvent"] as? [String: Any] {
                switch ame["type"] as? String {
                case "text_delta": streamingText += (ame["delta"] as? String) ?? ""
                case "thinking_delta": streamingThinking += (ame["delta"] as? String) ?? ""
                default: break
                }
            }
        case "tool_execution_start":
            if let id = raw["toolCallId"] as? String {
                let name = (raw["toolName"] as? String) ?? "tool"
                let args = (raw["args"] as? [String: Any]) ?? [:]
                liveTools.removeAll { $0.id == id }
                liveTools.append(LiveTool(id: id, name: name, args: args, done: false, isError: false))
            }
        case "tool_execution_end":
            if let id = raw["toolCallId"] as? String,
               let idx = liveTools.firstIndex(where: { $0.id == id }) {
                liveTools[idx].done = true
                liveTools[idx].isError = (raw["isError"] as? Bool) ?? false
            }
        case "turn_end", "agent_end":
            if type == "agent_end" {
                isStreaming = false
                streamingText = ""
                streamingThinking = ""
                liveTools.removeAll()
                // Reload committed truth from the file tail: captures tool calls/results,
                // todo/goal/subagent custom entries, final assistant text, and usage.
                reloadFromFile()
                rpc.getSessionStats()
                if let cb = onAgentEndOnce { onAgentEndOnce = nil; DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { cb() } }
            }
        case "tool_execution_end":
            // Live tool result will be reflected on the next reload (agent_end).
            break
        default:
            break
        }
    }

    // MARK: - Extension UI

    private func handleUIRequest(_ req: RpcUIRequest) {
        if req.isDialog {
            pendingDialog = PendingDialog(request: req)
            return
        }
        // Fire-and-forget.
        switch req.method {
        case "setStatus":
            let key = (req.raw["statusKey"] as? String) ?? ""
            if let text = req.raw["statusText"] as? String {
                statusEntries[key] = ANSI.strip(text)
            } else {
                statusEntries.removeValue(forKey: key)
            }
        case "notify":
            notify((req.raw["message"] as? String) ?? "", type: (req.raw["notifyType"] as? String) ?? "info")
        case "setTitle", "setWidget", "set_editor_text":
            break // surfaced elsewhere or no-op
        default:
            break
        }
    }

    func answerDialog(_ dialog: PendingDialog, value: String?, confirmed: Bool?) {
        if let confirmed { rpc.uiRespond(id: dialog.request.id, confirmed: confirmed) }
        else if let value { rpc.uiRespond(id: dialog.request.id, value: value) }
        else { rpc.uiCancel(id: dialog.request.id) }
        pendingDialog = nil
    }

    private func notify(_ text: String, type: String) {
        notifications.append(AppNotification(text: text, type: type))
    }
}

struct PendingDialog: Identifiable {
    let request: RpcUIRequest
    var id: String { request.id }
    var method: String { request.method }
    var title: String { (request.raw["title"] as? String) ?? "" }
    var message: String? { request.raw["message"] as? String }
    var options: [String] { (request.raw["options"] as? [String]) ?? [] }
    var placeholder: String? { request.raw["placeholder"] as? String }
    var prefill: String? { request.raw["prefill"] as? String }
}

struct AppNotification: Identifiable {
    let id = UUID()
    let text: String
    let type: String
}

struct SlashCommand: Identifiable {
    let name: String
    let description: String?
    let source: String
    var id: String { name }
}

/// An in-flight tool call rendered live during streaming.
struct LiveTool: Identifiable {
    let id: String
    let name: String
    let args: [String: Any]
    var done: Bool
    var isError: Bool
}

enum ANSI {
    /// Strip ANSI SGR escape sequences (e.g. \u001b[38;2;102;102;102m).
    static func strip(_ s: String) -> String {
        guard s.contains("\u{1B}") else { return s }
        var out = ""
        var i = s.startIndex
        while i < s.endIndex {
            let c = s[i]
            if c == "\u{1B}" {
                // skip until a letter (the final byte of the CSI sequence)
                var j = s.index(after: i)
                while j < s.endIndex, !s[j].isLetter { j = s.index(after: j) }
                if j < s.endIndex { j = s.index(after: j) }
                i = j
            } else {
                out.append(c)
                i = s.index(after: i)
            }
        }
        return out
    }
}
