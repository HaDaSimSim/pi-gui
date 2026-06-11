import Foundation
import PiCore

// Runtime manager: ties an RpcClient to a SessionLock, mirroring server/runtime-manager.ts.
// One RuntimeSession per open/live session. The load-bearing rule from AGENTS.md moves here:
// lock.isMine() is re-checked before EVERY prompt send (pi won't enforce it under PI_WEB_HOST).

@MainActor
@Observable
public final class RuntimeSession: RpcClientDelegate {
  public let id = UUID()
  public let cwd: String
  public private(set) var sessionPath: String?

  // Live transcript built from streamed events (separate from the file-read scrollback).
  // The in-progress assistant turn is committed directly into `items` like the web's
  // messages[] (no clear-then-reload), so a racing file read can never blank a live turn.
  public var items: [TranscriptItem] = [] {
    didSet { _latestTodo = Self.computeLatestTodo(items) }
  }
  public var isStreaming = false
  public var footer = FooterStats()
  public var model: String?
  public var thinkingLevel: String = "off"
  public var sessionName: String?

  /// Display title for UI (tabs, sidebar, window title): session name → first user prompt → cwd basename.
  public var displayTitle: String {
    if let name = sessionName, !name.isEmpty { return name }
    // Fallback: first user message text (truncated).
    for item in items {
      if case .user(_, let text, _) = item, !text.isEmpty {
        return String(text.prefix(40))
      }
    }
    return Fmt.dirBasename(cwd)
  }
  public var lockStatus: LockUIStatus = .owned
  /// Set when pi process exits unexpectedly (not via dispose). Surfaces a persistent banner.
  public var processExited = false
  /// True while reloadFromFile() is in flight (loading from disk).
  public var isLoading = false
  /// True after ensureRuntimeStarted is called but before the first get_state response arrives.
  public var isStartingUp = false
  public var pendingDialog: PendingDialog?
  public var questionnaire: QuestionnaireState?
  public var statusEntries: [String: String] = [:]  // statusKey -> text (ANSI stripped)
  public var notifications: [AppNotification] = []
  public var commands: [SlashCommand] = []

  /// Cached latest todo list (updated when `items` changes). Avoids repeated
  /// O(n) scans of items.reversed() in ComposerView's body.
  public private(set) var _latestTodo: [TodoItem]?
  public var latestTodo: [TodoItem]? { _latestTodo }

  private static func computeLatestTodo(_ items: [TranscriptItem]) -> [TodoItem]? {
    for item in items.reversed() {
      if case .todoList(_, let todos) = item { return todos }
    }
    return nil
  }

  private let rpc = RpcClient()
  private var lock: SessionLock?
  private let piPath: String
  private let model0: String?
  private let sessionDir: String?
  public private(set) var isStarted = false
  private var disposed = false

  /// For browse-only tabs: point at an existing session file without spawning pi.
  public func setSessionPathForBrowsing(_ path: String) {
    sessionPath = path
  }

  /// How many bytes from the end of the session file the scrollback currently covers. Grows
  /// when the user loads earlier history. Footer aggregation always uses the full file.
  public var historyBytes = 8 * 1024 * 1024
  public var hasEarlierHistory = false

  /// Reload the committed transcript from the session file tail (OOM-safe). This is the
  /// source of truth for tool calls/results, todo/goal/subagent state, and final text.
  ///
  /// P0-2: this is NON-DESTRUCTIVE. pi appends to the jsonl with appendFileSync while we open
  /// our own FileHandle, so a reload fired on agent_end can race the write and capture a
  /// truncated tail. We therefore only adopt the reloaded items when they're non-empty; an
  /// empty/failed read keeps whatever we already streamed into `items`, so a live turn is
  /// never blanked. `localElapsed` re-applies the locally-measured elapsed to the
  /// just-finished assistant turn (the file's turn-meta lands one turn late — P0-3).
  public func reloadFromFile(localElapsed: Double? = nil) {
    guard let path = sessionPath else { return }
    isLoading = true
    let currentHistoryBytes = historyBytes
    let currentLiveCallIds = liveCallIds
    Task.detached { [weak self] in
      let sf = SessionFile(path: path)
      guard let entries = try? sf.tailEntries(maxLines: Int.max, maxBytes: currentHistoryBytes)
      else {
        return
      }
      let rebuilt = Transcript.build(
        from: entries, hideThinking: false, liveCallIds: currentLiveCallIds)
      let newFooter: FooterStats?
      if let full = try? sf.fullFooter() {
        newFooter = full
      } else {
        newFooter = Transcript.footer(from: entries)
      }
      let size =
        ((try? FileManager.default.attributesOfItem(atPath: path))?[.size] as? Int) ?? 0
      let hasEarlier = size > currentHistoryBytes
      await MainActor.run { [weak self] in
        guard let self else { return }
        self.isLoading = false
        // Don't clear a streamed turn if the read came back empty (truncated/racing write).
        if !rebuilt.isEmpty || self.items.isEmpty {
          var next = rebuilt
          if let localElapsed { self.applyElapsed(localElapsed, to: &next) }
          self.items = next
        } else if let localElapsed {
          self.applyElapsed(localElapsed, to: &self.items)
        }
        if let newFooter {
          self.footer = newFooter
        }
        if self.footer.model != nil { self.model = self.footer.model }
        self.hasEarlierHistory = hasEarlier
      }
    }
  }

  /// Stamp `elapsed` onto the most recent assistant item (the just-finished turn). Mirrors
  /// web's agent_end loop that sets elapsedMs on the last assistant message.
  private func applyElapsed(_ elapsed: Double, to items: inout [TranscriptItem]) {
    for idx in stride(from: items.count - 1, through: 0, by: -1) {
      if case .assistant(let aid, var am) = items[idx] {
        am.elapsed = elapsed
        items[idx] = .assistant(id: aid, msg: am)
        break
      }
    }
  }

  /// Load an earlier slice of history (doubles the window) and re-render.
  public func loadEarlierHistory() {
    historyBytes *= 2
    reloadFromFile()
  }

  public enum LockUIStatus: Equatable { case owned, readOnly, lost }

  public init(cwd: String, piPath: String, model: String?, sessionDir: String?) {
    self.cwd = cwd
    self.piPath = piPath
    self.model0 = model
    self.sessionDir = sessionDir
  }

  public func start() throws {
    guard !isStarted else { return }
    isStartingUp = true
    // If we're opening an existing session file, pass its dir so the new RPC writes there,
    // and switch_session to resume it (otherwise pi mints a brand-new session file).
    let resumePath = sessionPath
    let dir = resumePath.map { ($0 as NSString).deletingLastPathComponent } ?? sessionDir
    // When resuming an existing session, don't pass --model — let pi use the session's
    // persisted model. Only pass --model for brand-new sessions.
    let modelArg = resumePath == nil ? model0 : nil
    try rpc.start(piPath: piPath, cwd: cwd, model: modelArg, sessionDir: dir)
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
      let l = SessionLock(
        sessionPath: path, owner: "pi-web", label: sessionName.map { "pi-gui: \($0)" } ?? "pi-gui")
      let r = l.tryAcquire()
      lock = l
      lockStatus = r.acquired ? .owned : .readOnly
      #if DEBUG
        print("[pi-gui] ensureLock: path=\(path) acquired=\(r.acquired) lockFile=\(l.lockFilePath)")
      #endif
    }
    // Flush a prompt that was issued before the session path/lock was known.
    if pendingPrompt != nil || !pendingImages.isEmpty {
      let p = pendingPrompt ?? ""
      let imgs = pendingImages
      pendingPrompt = nil
      pendingImages = []
      sendPrompt(p, images: imgs)
    }
  }

  // MARK: - User actions (lock guard enforced here)

  public func sendPrompt(
    _ text: String, images: [[String: Any]] = [], streamingBehavior: String? = nil
  ) {
    guard !text.isEmpty || !images.isEmpty else { return }
    // P1-1: optimistically show the user's own message immediately so it appears in the
    // transcript even while the lock/session is still being acquired (queued prompt case).
    // appendUserIfNew dedups against a re-emitted message_start(user) or a flush replay.
    // Only for non-steer sends (steer position settles when message_start(user) arrives).
    if !isStreaming && !text.isEmpty { appendUserIfNew(text) }
    // If the lock isn't established yet (get_state in flight), queue and send once it
    // arrives. Keying on the lock (not sessionPath) is load-bearing: a resumed/browsed
    // session has sessionPath set before start, so a sessionPath-based guard would let a
    // prompt through with lock == nil and risk two writers on one jsonl.
    guard let lock else {
      pendingPrompt = text
      pendingImages = images
      return
    }
    // Load-bearing re-check: refuse to write if we no longer hold the lock.
    if !lock.isMine() {
      lockStatus = .lost
      notify("Lost the session lock — read-only.", type: "error")
      return
    }
    if isStreaming {
      let behavior = streamingBehavior ?? "steer"
      rpc.prompt(text, streamingBehavior: behavior, images: images)
    } else {
      rpc.prompt(text, images: images)
    }
  }

  private var pendingPrompt: String?
  private var pendingImages: [[String: Any]] = []
  private var lockWatch: Timer?

  /// In-flight tool calls during the current streaming turn (cleared on agent_end reload).
  public var liveTools: [LiveTool] = []
  /// Transient activity banner (retry countdown / compaction), shown above the composer.
  public var activityBanner: String?

  // MARK: - Streaming turn accumulation (mirrors web's streamingRef + turnStartRef)

  /// The `items` index of the assistant message currently being streamed, or nil when idle.
  /// We mutate this item in place as deltas/tools arrive so live order == committed order.
  private var streamingIndex: Int?
  /// Wall-clock start of the current agent run, used to compute elapsed locally for the
  /// just-finished turn (ui-cosmetics writes the file turn-meta one turn late — P0-3).
  private var turnStart: Date?
  /// Set by abort() so the next agent_end marks the streamed turn as interrupted (web's
  /// interruptedRef).
  private var userInterrupted = false
  /// Ordered call-ids of tools seen in the live turn, so a reload can map split results.
  private var liveCallIds: Set<String> = []

  /// Re-check lock ownership before any write command. Returns true only when we positively
  /// hold the lock. nil lock (not yet acquired) or a lost lock both refuse — this is the
  /// single guard that prevents two writers from corrupting a session jsonl.
  private func holdsLockForWrite() -> Bool {
    guard let lock else { return false }
    if !lock.isMine() {
      if lockStatus != .lost {
        lockStatus = .lost
        notify("Lost the session lock — read-only.", type: "error")
      }
      return false
    }
    return true
  }

  public func abort() {
    guard holdsLockForWrite() else { return }
    userInterrupted = true  // consumed at the next agent_end to mark the turn interrupted.
    rpc.abort()
  }
  public func setModel(provider: String, modelId: String) {
    guard holdsLockForWrite() else { return }
    rpc.setModel(provider: provider, modelId: modelId)
  }

  /// Run a bash command in the session (the !/!! editor convention). The RPC `bash` command
  /// adds the output to context (unless excludeFromContext). Result surfaces on next reload.
  public func runBash(_ command: String, excludeFromContext: Bool) {
    guard !command.isEmpty else { return }
    guard holdsLockForWrite() else { return }
    rpc.send(["type": "bash", "command": command, "excludeFromContext": excludeFromContext])
    // Reflect the result shortly after; bash is synchronous-ish over RPC.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in self?.reloadFromFile() }
  }

  // MARK: - Test support

  public var sessionPathForTest: String? { sessionPath }
  private var onAgentEndOnce: (() -> Void)?

  /// Send a prompt and call back once the first agent_end fires. The prompt is auto-queued
  /// until the session path/lock is ready (see sendPrompt). Used by the headless self-test.
  public func sendPromptWhenReady(_ text: String, completion: @escaping () -> Void) {
    onAgentEndOnce = completion
    sendPrompt(text)
  }
  public func setThinking(_ level: String) {
    guard holdsLockForWrite() else { return }
    rpc.setThinkingLevel(level)
  }
  public func rename(_ name: String) {
    guard holdsLockForWrite() else { return }
    sessionName = name
    rpc.setSessionName(name)
  }
  public func compact() {
    guard holdsLockForWrite() else { return }
    rpc.compact()
  }

  public func takeover() {
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

  public func dispose() {
    disposed = true
    lockWatch?.invalidate()
    lockWatch = nil
    rpc.terminate()
    lock?.release()
    lock = nil
  }

  // MARK: - RpcClientDelegate

  nonisolated func rpc(_ client: RpcClient, didReceive incoming: RpcIncoming) {
    Task { @MainActor in self.handle(incoming) }
  }
  nonisolated func rpcDidExit(_ client: RpcClient, code: Int32) {
    Task { @MainActor in
      self.isStreaming = false
      self.isStartingUp = false
      if !self.disposed {
        self.processExited = true
      }
    }
  }

  private func handle(_ incoming: RpcIncoming) {
    switch incoming {
    case .response(_, let command, let success, let data, let error):
      handleResponse(command: command, success: success, data: data, error: error)
    case .uiRequest(let req):
      handleUIRequest(req)
    case .event(let type, let raw):
      handleEvent(type: type, raw: raw)
    }
  }

  private func handleResponse(command: String, success: Bool, data: [String: Any]?, error: String?)
  {
    // Surface command-level failures (e.g. prompt rejected, unknown model) instead of
    // silently dropping them — otherwise a rejected write looks like a no-op to the user.
    if !success {
      let detail = error ?? "unknown error"
      notify("\(command) failed: \(detail)", type: "error")
      if command == "prompt" { isStreaming = false }
      return
    }
    switch command {
    case "get_state":
      if let data {
        isStartingUp = false
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
          return SlashCommand(
            name: name, description: c["description"] as? String,
            source: (c["source"] as? String) ?? "",
            argumentHint: c["argumentHint"] as? String)
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
      turnStart = Date()  // P0-3: measure elapsed locally for the just-finished turn.
      userInterrupted = false
      liveCallIds.removeAll()
      streamingIndex = nil  // a fresh assistant message will be opened on message_start.
    case "message_start":
      // P1-2: open a NEW assistant item per assistant message so text/thinking reset between
      // messages within one agent run (mirrors web's streamingRef reset on message_start).
      if let msg = raw["message"] as? [String: Any] {
        let role = msg["role"] as? String
        if role == "assistant" {
          openStreamingAssistant()
        } else if role == "user" {
          // A user message delivered via steer/followUp. Add it unless already present
          // (matches web: scan back to the previous assistant turn for the same text).
          if let text = SessionStore.extractText(msg["content"])?
            .trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty
          {
            appendUserIfNew(text)
          }
        }
      }
    case "message_update":
      if let ame = raw["assistantMessageEvent"] as? [String: Any] {
        switch ame["type"] as? String {
        case "text_delta":
          mutateStreaming { $0.text += (ame["delta"] as? String) ?? "" }
        case "thinking_delta":
          mutateStreaming { $0.thinking = ($0.thinking ?? "") + ((ame["delta"] as? String) ?? "") }
        default: break
        }
      }
    case "tool_execution_start":
      if let id = raw["toolCallId"] as? String {
        let name = (raw["toolName"] as? String) ?? "tool"
        let args = (raw["args"] as? [String: Any]) ?? [:]
        liveCallIds.insert(id)
        // P1-3: interleave the tool into the streaming assistant message in submission order
        // (text → tool → text renders in the right order, matching the eventual commit).
        upsertStreamingTool(id: id, name: name, args: args, status: "running", result: nil)
        // The questionnaire tool ships its full structured questions in args; capture
        // them to render one rich SwiftUI form instead of sequential native dialogs.
        if name == "questionnaire", let qs = args["questions"] as? [[String: Any]] {
          questionnaire = QuestionnaireState(toolCallId: id, questions: qs.map(QField.init))
        }
      }
    case "tool_execution_update":
      if let id = raw["toolCallId"] as? String {
        let partial = SessionStore.extractText((raw["partialResult"] as? [String: Any])?["content"])
        updateStreamingTool(id: id) { tc in
          tc.status = "running"
          if let partial { tc.resultText = partial }
        }
      }
    case "tool_execution_end":
      if let id = raw["toolCallId"] as? String {
        let isError = (raw["isError"] as? Bool) ?? false
        let result = SessionStore.extractText((raw["result"] as? [String: Any])?["content"])
        updateStreamingTool(id: id) { tc in
          tc.status = isError ? "error" : "done"
          if let result { tc.resultText = result }
        }
      }
      if questionnaire?.toolCallId == (raw["toolCallId"] as? String) {
        questionnaire = nil
      }
    case "message_end":
      // Mark the streamed message done; attach errorMessage if it ended in abort/error
      // (tools still run after message_end, so don't touch tool statuses here — web parity).
      if let stop = (raw["message"] as? [String: Any])?["stopReason"] as? String,
        stop == "aborted" || stop == "error"
      {
        let errMsg = (raw["message"] as? [String: Any])?["errorMessage"] as? String
        mutateStreaming { am in
          if stop == "error" { am.errorMessage = errMsg ?? "Error" }
        }
      }
      mutateStreaming { $0.streaming = false }
      streamingIndex = nil
    case "turn_end":
      break
    case "agent_end":
      finishTurn()
    case "session_error":
      isStreaming = false
      notify((raw["message"] as? String) ?? "Prompt rejected", type: "error")
    case "backend_error":
      notify((raw["message"] as? String) ?? "Backend error", type: "error")
    case "auto_retry_start":
      let attempt = (raw["attempt"] as? Int) ?? 1
      let maxA = (raw["maxAttempts"] as? Int) ?? 1
      let delay = ((raw["delayMs"] as? Int) ?? 0) / 1000
      activityBanner = "Retrying (\(attempt)/\(maxA)) in \(delay)s\u{2026}"
    case "auto_retry_end":
      activityBanner = nil
      if (raw["success"] as? Bool) == false {
        notify("Retry failed: \((raw["finalError"] as? String) ?? "unknown")", type: "error")
      }
    case "compaction_start":
      activityBanner = "Compacting context\u{2026}"
    case "compaction_end":
      activityBanner = nil
      reloadFromFile()
    default:
      break
    }
  }

  // MARK: - Streaming turn helpers (mirror web's streamingRef / flushStreaming)

  /// Open a fresh assistant item for a new streamed message and remember its index.
  private func openStreamingAssistant() {
    let am = AssistantMessage(
      text: "", thinking: nil, toolCalls: [], model: model,
      timestamp: Date(), elapsed: nil, streaming: true)
    items.append(.assistant(id: "stream-\(UUID().uuidString)", msg: am))
    streamingIndex = items.count - 1
  }

  /// Mutate the in-progress streamed assistant message in place. Opens one lazily if a delta
  /// arrives before message_start (web does the same).
  private func mutateStreaming(_ body: (inout AssistantMessage) -> Void) {
    if streamingIndex == nil || !indexIsStreamingAssistant(streamingIndex!) {
      openStreamingAssistant()
    }
    // Guard: validate streamingIndex is still in bounds AND points to an assistant message.
    // A concurrent reloadFromFile could have replaced `items`, invalidating the index.
    guard let idx = streamingIndex, items.indices.contains(idx),
      case .assistant(let aid, var am) = items[idx]
    else { return }
    body(&am)
    items[idx] = .assistant(id: aid, msg: am)
  }

  private func indexIsStreamingAssistant(_ idx: Int) -> Bool {
    guard items.indices.contains(idx), case .assistant = items[idx] else { return false }
    return true
  }

  /// Append or replace a tool call within the streaming assistant message (submission order).
  private func upsertStreamingTool(
    id: String, name: String, args: [String: Any], status: String, result: String?
  ) {
    mutateStreaming { am in
      if let j = am.toolCalls.firstIndex(where: { $0.id == id }) {
        am.toolCalls[j].status = status
        if let result { am.toolCalls[j].resultText = result }
      } else {
        am.toolCalls.append(
          ToolCallView(id: id, name: name, args: args, status: status, resultText: result))
      }
    }
  }

  /// Update a tool call by id wherever it lives (streaming item first, else scan back through
  /// committed items — a tool may finish after message_end when streamingIndex is nil).
  private func updateStreamingTool(id: String, _ mutate: (inout ToolCallView) -> Void) {
    for idx in stride(from: items.count - 1, through: 0, by: -1) {
      if case .assistant(let aid, var am) = items[idx],
        let j = am.toolCalls.firstIndex(where: { $0.id == id })
      {
        mutate(&am.toolCalls[j])
        items[idx] = .assistant(id: aid, msg: am)
        return
      }
    }
  }

  /// Append a user message unless the same text already sits in the trailing run of user
  /// messages (back to the previous assistant turn). Mirrors web's message_start(user) dedup
  /// and also dedups against the optimistic message added in sendPrompt.
  private func appendUserIfNew(_ text: String) {
    for idx in stride(from: items.count - 1, through: 0, by: -1) {
      switch items[idx] {
      case .assistant: return  // stop at the previous assistant turn
      case .user(_, let t, _): if t == text { return }
      default: break
      }
    }
    items.append(.user(id: "u-\(UUID().uuidString)", text: text, timestamp: Date()))
  }

  /// agent_end: finalize the streamed turn in place (P0-2 — no clear-then-reload), compute
  /// elapsed locally (P0-3), mark interrupted if the user aborted, then do a guarded reload to
  /// adopt committed truth (tool results, custom entries) WITHOUT blanking the live turn.
  private func finishTurn() {
    isStreaming = false
    streamingIndex = nil
    let elapsed = turnStart.map { Date().timeIntervalSince($0) }
    turnStart = nil

    // Drop a trailing empty assistant message (created right after abort/end with no content).
    if case .assistant(_, let am)? = items.last,
      am.text.trimmingCharacters(in: .whitespaces).isEmpty,
      (am.thinking ?? "").isEmpty, am.toolCalls.isEmpty
    {
      items.removeLast()
    }
    // Finalize the last assistant turn: clear the streaming flag, stamp elapsed, and mark
    // interruption (any still-running tool becomes error, like web).
    for idx in stride(from: items.count - 1, through: 0, by: -1) {
      if case .assistant(let aid, var am) = items[idx] {
        am.streaming = false
        if let elapsed { am.elapsed = elapsed }
        if userInterrupted {
          am.interrupted = true
          for j in am.toolCalls.indices where am.toolCalls[j].status == "running" {
            am.toolCalls[j].status = "error"
          }
        }
        items[idx] = .assistant(id: aid, msg: am)
        break
      }
    }
    userInterrupted = false
    liveTools.removeAll()

    // Guarded reload: adopt the file's committed items (which carry tool results, todo/goal/
    // subagent custom entries, and final usage) but keep the local elapsed on the just-
    // finished turn. reloadFromFile won't clear `items` if the read is empty/truncated.
    reloadFromFile(localElapsed: elapsed)
    rpc.getSessionStats()
    if let cb = onAgentEndOnce {
      onAgentEndOnce = nil
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { cb() }
    }
  }

  // MARK: - Extension UI

  private func handleUIRequest(_ req: RpcUIRequest) {
    if req.isDialog {
      // If a questionnaire is active, its sequential select/input dialogs are driven by the
      // rich form (matched in question order) rather than shown as generic dialogs.
      if questionnaire != nil, req.method == "select" || req.method == "input" {
        questionnaire?.pendingRequests.append(req)
        drainQuestionnaireIfReady()
        return
      }
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
      notify(
        (req.raw["message"] as? String) ?? "", type: (req.raw["notifyType"] as? String) ?? "info")
    case "setTitle", "setWidget", "set_editor_text":
      break  // surfaced elsewhere or no-op
    default:
      break
    }
  }

  public func answerDialog(_ dialog: PendingDialog, value: String?, confirmed: Bool?) {
    if let confirmed {
      rpc.uiRespond(id: dialog.request.id, confirmed: confirmed)
    } else if let value {
      rpc.uiRespond(id: dialog.request.id, value: value)
    } else {
      rpc.uiCancel(id: dialog.request.id)
    }
    pendingDialog = nil
  }

  /// Submit the whole questionnaire form. Answers are matched to the sequential select/input
  /// requests pi emits (in question order). Cancelling cancels the first pending request, which
  /// makes the question extension abort the whole questionnaire.
  public func submitQuestionnaire(_ answers: [String]) {
    guard let q = questionnaire else { return }
    q.answers = answers
    q.submitted = true
    questionnaire = q
    drainQuestionnaireIfReady()
  }

  public func cancelQuestionnaire() {
    guard let q = questionnaire else { return }
    // Cancel any already-queued request; subsequent ones won't arrive once aborted.
    for req in q.pendingRequests { rpc.uiCancel(id: req.id) }
    questionnaire = nil
  }

  /// Match queued select/input requests to submitted answers in arrival order.
  private func drainQuestionnaireIfReady() {
    guard let q = questionnaire, q.submitted else { return }
    while q.nextAnswerIndex < q.pendingRequests.count,
      q.nextAnswerIndex < q.answers.count
    {
      let req = q.pendingRequests[q.nextAnswerIndex]
      let ans = q.answers[q.nextAnswerIndex]
      if req.method == "select" {
        // Map the chosen option value to the label pi expects back (it indexes by label).
        let qf = q.questions[safe: q.nextAnswerIndex]
        let label = qf?.options.first(where: { $0.value == ans })?.label ?? ans
        rpc.uiRespond(id: req.id, value: label)
      } else {
        rpc.uiRespond(id: req.id, value: ans)
      }
      q.nextAnswerIndex += 1
    }
    questionnaire = q
  }

  public func notify(_ text: String, type: String) {
    notifications.append(AppNotification(text: text, type: type))
  }
}

public struct PendingDialog: Identifiable {
  public let request: RpcUIRequest
  public var id: String { request.id }
  public var method: String { request.method }
  public var title: String { (request.raw["title"] as? String) ?? "" }
  public var message: String? { request.raw["message"] as? String }
  public var options: [String] { (request.raw["options"] as? [String]) ?? [] }
  public var placeholder: String? { request.raw["placeholder"] as? String }
  public var prefill: String? { request.raw["prefill"] as? String }
}

/// Live questionnaire state: the structured questions (from the tool args) plus the sequential
/// select/input requests pi emits, which the rich form answers in order.
/// This local version uses the concrete RpcUIRequest type for pendingRequests.
public final class QuestionnaireState {
  public let toolCallId: String
  public let questions: [QField]
  public var pendingRequests: [RpcUIRequest] = []
  public var answers: [String] = []
  public var submitted = false
  public var nextAnswerIndex = 0
  public init(toolCallId: String, questions: [QField]) {
    self.toolCallId = toolCallId
    self.questions = questions
  }
}
