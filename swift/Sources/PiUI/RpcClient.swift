import Foundation
import PiCore

// RPC client: spawns `pi --mode rpc` and talks JSONL over stdin/stdout.
// Protocol-compliant LF-only framing (per docs/rpc.md): split on "\n" only, strip a trailing
// "\r", never treat U+2028/U+2029 as newlines. We do raw byte buffer splitting on 0x0A.
//
// stdout carries three kinds of lines, discriminated by "type":
//   - "response": command ack, correlated by "id"
//   - "extension_ui_request": dialog (needs extension_ui_response) or fire-and-forget
//   - everything else: agent events (agent_start, message_update, tool_execution_*, agent_end, ...)

// MARK: - Framing

/// Splits an incoming byte stream into LF-delimited UTF-8 lines, stripping a trailing CR.
final class JSONLFramer {
  private var buffer = Data()
  func feed(_ chunk: Data, _ onLine: (String) -> Void) {
    buffer.append(chunk)
    while let nl = buffer.firstIndex(of: 0x0A) {
      var lineData = buffer.subdata(in: buffer.startIndex..<nl)
      buffer = buffer.subdata(in: buffer.index(after: nl)..<buffer.endIndex)
      if lineData.last == 0x0D { lineData = lineData.dropLast() }
      if lineData.isEmpty { continue }
      if let s = String(data: lineData, encoding: .utf8) { onLine(s) }
    }
  }
  func flush(_ onLine: (String) -> Void) {
    guard !buffer.isEmpty else { return }
    var lineData = buffer
    if lineData.last == 0x0D { lineData = lineData.dropLast() }
    if let s = String(data: lineData, encoding: .utf8), !s.isEmpty { onLine(s) }
    buffer.removeAll()
  }
}

// MARK: - Incoming message classification

enum RpcIncoming {
  case response(id: String?, command: String, success: Bool, data: [String: Any]?, error: String?)
  case uiRequest(RpcUIRequest)
  case event(type: String, raw: [String: Any])
}

public struct RpcUIRequest {
  let id: String
  let method: String  // select/confirm/input/editor/notify/setStatus/setWidget/setTitle/set_editor_text
  let raw: [String: Any]
  var isDialog: Bool { ["select", "confirm", "input", "editor"].contains(method) }
}

func classifyIncoming(_ obj: [String: Any]) -> RpcIncoming? {
  guard let type = obj["type"] as? String else { return nil }
  switch type {
  case "response":
    return .response(
      id: obj["id"] as? String,
      command: (obj["command"] as? String) ?? "",
      success: (obj["success"] as? Bool) ?? false,
      data: obj["data"] as? [String: Any],
      error: obj["error"] as? String
    )
  case "extension_ui_request":
    guard let id = obj["id"] as? String, let method = obj["method"] as? String else { return nil }
    return .uiRequest(RpcUIRequest(id: id, method: method, raw: obj))
  default:
    return .event(type: type, raw: obj)
  }
}

// MARK: - RPC process client

protocol RpcClientDelegate: AnyObject {
  func rpc(_ client: RpcClient, didReceive incoming: RpcIncoming)
  func rpcDidExit(_ client: RpcClient, code: Int32)
}

/// One RpcClient == one `pi --mode rpc` process == one session.
final class RpcClient {
  private let process = Process()
  private var didLaunch = false
  private let stdinPipe = Pipe()
  private let stdoutPipe = Pipe()
  private let stderrPipe = Pipe()
  private let framer = JSONLFramer()
  private let writeQueue = DispatchQueue(label: "rpc.write")
  weak var delegate: RpcClientDelegate?

  /// Spawn pi --mode rpc. `piPath` is the absolute pi binary; `cwd` becomes the session's
  /// working directory; PI_WEB_HOST=1 is injected so pi's session-lock extension bails and
  /// question/btw use the native (select/input) fallback.
  func start(
    piPath: String,
    cwd: String,
    model: String? = nil,
    sessionDir: String? = nil,
    extraArgs: [String] = []
  ) throws {
    var args = ["--mode", "rpc"]
    if let model { args += ["--model", model] }
    if let sessionDir { args += ["--session-dir", sessionDir] }
    args += extraArgs

    process.executableURL = URL(fileURLWithPath: piPath)
    process.arguments = args
    process.currentDirectoryURL = URL(fileURLWithPath: cwd)
    var env = ProcessInfo.processInfo.environment
    env["PI_WEB_HOST"] = "1"
    // GUI apps don't inherit the login PATH, so #!/usr/bin/env node in the pi shim can't
    // find node. Inject the pi binary's parent directory (which also contains node) into
    // PATH so the shebang resolves correctly.
    let piBinDir = (piPath as NSString).deletingLastPathComponent
    let existingPath = env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
    if !existingPath.contains(piBinDir) {
      env["PATH"] = "\(piBinDir):\(existingPath)"
    }
    process.environment = env
    process.standardInput = stdinPipe
    process.standardOutput = stdoutPipe
    process.standardError = stderrPipe

    stdoutPipe.fileHandleForReading.readabilityHandler = { [weak self] fh in
      guard let self else { return }
      let chunk = fh.availableData
      if chunk.isEmpty { return }
      self.framer.feed(chunk) { line in
        guard let obj = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
          let incoming = classifyIncoming(obj)
        else { return }
        self.delegate?.rpc(self, didReceive: incoming)
      }
    }
    // Drain stderr to avoid backpressure (and surface errors via logging later).
    stderrPipe.fileHandleForReading.readabilityHandler = { fh in _ = fh.availableData }

    process.terminationHandler = { [weak self] proc in
      guard let self else { return }
      self.stdoutPipe.fileHandleForReading.readabilityHandler = nil
      self.stderrPipe.fileHandleForReading.readabilityHandler = nil
      self.delegate?.rpcDidExit(self, code: proc.terminationStatus)
    }

    try process.run()
    didLaunch = true
  }

  /// Send a command object as a single LF-terminated JSON line.
  func send(_ command: [String: Any]) {
    guard didLaunch else { return }
    guard let data = try? JSONSerialization.data(withJSONObject: command, options: []) else {
      return
    }
    var line = data
    line.append(0x0A)
    writeQueue.async { [weak self] in
      self?.stdinPipe.fileHandleForWriting.write(line)
    }
  }

  func terminate() {
    // No-op if the process was never launched (browse-only tabs). Calling terminate() or
    // writing to the stdin pipe before run() raises NSInvalidArgumentException and crashes.
    guard didLaunch else { return }
    send(["type": "abort"])
    writeQueue.async { [weak self] in
      try? self?.stdinPipe.fileHandleForWriting.close()
    }
    if process.isRunning { process.terminate() }
    // SIGKILL fallback: if the process ignores SIGTERM and is still running after 3s, force-kill.
    let proc = process
    let launched = didLaunch
    DispatchQueue.global().asyncAfter(deadline: .now() + 3.0) {
      guard launched, proc.isRunning else { return }
      kill(proc.processIdentifier, SIGKILL)
    }
  }

  var isRunning: Bool { didLaunch && process.isRunning }

  // MARK: - Typed command helpers

  func prompt(
    _ message: String, streamingBehavior: String? = nil, id: String? = nil,
    images: [[String: Any]] = []
  ) {
    var cmd: [String: Any] = ["type": "prompt", "message": message]
    if let id { cmd["id"] = id }
    if let streamingBehavior { cmd["streamingBehavior"] = streamingBehavior }
    if !images.isEmpty { cmd["images"] = images }
    send(cmd)
  }
  func steer(_ message: String) { send(["type": "steer", "message": message]) }
  func followUp(_ message: String) { send(["type": "follow_up", "message": message]) }
  func abort() { send(["type": "abort"]) }
  func getState(id: String = "get_state") { send(["id": id, "type": "get_state"]) }
  func getSessionStats(id: String = "stats") { send(["id": id, "type": "get_session_stats"]) }
  func getCommands(id: String = "commands") { send(["id": id, "type": "get_commands"]) }
  func setModel(provider: String, modelId: String) {
    send(["type": "set_model", "provider": provider, "modelId": modelId])
  }
  func setThinkingLevel(_ level: String) { send(["type": "set_thinking_level", "level": level]) }
  func setSessionName(_ name: String) { send(["type": "set_session_name", "name": name]) }
  func compact() { send(["type": "compact"]) }
  func switchSession(_ path: String) { send(["type": "switch_session", "sessionPath": path]) }

  /// Reply to an extension_ui_request dialog.
  func uiRespond(id: String, value: String) {
    send(["type": "extension_ui_response", "id": id, "value": value])
  }
  func uiRespond(id: String, confirmed: Bool) {
    send(["type": "extension_ui_response", "id": id, "confirmed": confirmed])
  }
  func uiCancel(id: String) {
    send(["type": "extension_ui_response", "id": id, "cancelled": true])
  }
}
