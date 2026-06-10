import Foundation
import CryptoKit

// Port of vendor/pi-skills/extensions/session-lock/shared/session-lock.ts.
// Byte-identical protocol so pi (TUI/CLI) and this host interoperate.
//
// The on-disk record shape, the SHA1-of-sessionPath key, the atomic temp+rename
// write, and the token-comparison state machine all match the TS source exactly.
// owner stays "pi-web" (a protocol identity value the pi TUI matches against).

struct LockRecord: Codable, Equatable {
    var sessionPath: String
    var owner: String          // "pi" | "pi-web"
    var pid: Int
    var host: String
    var label: String?
    var since: Double          // epoch ms (JS Date.now())
    var token: String
}

enum LockState: Equatable {
    case free
    case mine(LockRecord)
    case lost(LockRecord?)
}

private func defaultLockDir() -> String {
    let env = ProcessInfo.processInfo.environment
    let agentDir = env["PI_AGENT_DIR"]
        ?? (env["HOME"].map { ($0 as NSString).appendingPathComponent(".pi/agent") })
        ?? ".pi/agent"
    return (agentDir as NSString).appendingPathComponent("locks")
}

private func keyFor(_ sessionPath: String) -> String {
    let digest = Insecure.SHA1.hash(data: Data(sessionPath.utf8))
    let hex = digest.map { String(format: "%02x", $0) }.joined()
    return String(hex.prefix(16))
}

private func hostName() -> String {
    // Matches Node os.hostname() closely enough for cross-host comparison.
    return ProcessInfo.processInfo.hostName
}

private func newToken() -> String {
    let pid = ProcessInfo.processInfo.processIdentifier
    let now = Int(Date().timeIntervalSince1970 * 1000)
    let rand = String(UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(6)).lowercased()
    return "\(pid)-\(now)-\(rand)"
}

/// Whether the PID is still alive on this host. Undeterminable => assume alive (safe).
private func pidAlive(_ pid: Int) -> Bool {
    if pid <= 0 { return false }
    let r = kill(pid_t(pid), 0)
    if r == 0 { return true }
    return errno == EPERM   // EPERM = alive but not ours; ESRCH = gone
}

/// Dead (orphan) lock: same host but the holding PID is gone.
func isStaleRecord(_ rec: LockRecord) -> Bool {
    let host = hostName()
    if !rec.host.isEmpty && !host.isEmpty && rec.host != host { return false }
    return !pidAlive(rec.pid)
}

/// An exclusive advisory lock on a single session file.
final class SessionLock {
    private let file: String
    private let dir: String
    private let sessionPath: String
    private let owner: String
    private let label: String?
    private var myToken: String?

    init(sessionPath: String, owner: String, label: String? = nil, lockDir: String = defaultLockDir()) {
        self.sessionPath = sessionPath
        self.owner = owner
        self.label = label
        self.dir = lockDir
        self.file = (lockDir as NSString).appendingPathComponent("\(keyFor(sessionPath)).json")
    }

    /// The lock file's basename for a given session path (sha1[:16].json). Exposed for tests.
    static func fileName(for sessionPath: String) -> String { "\(keyFor(sessionPath)).json" }

    private func read() -> LockRecord? {
        guard let data = FileManager.default.contents(atPath: file) else { return nil }
        return try? JSONDecoder().decode(LockRecord.self, from: data)
    }

    func state() -> LockState {
        let rec = read()
        guard let myToken else {
            return rec != nil ? .lost(rec) : .free
        }
        if let rec, rec.token == myToken { return .mine(rec) }
        return .lost(rec)
    }

    @discardableResult
    func tryAcquire() -> (acquired: Bool, current: LockRecord?) {
        let rec = read()
        if let rec, !(myToken != nil && rec.token == myToken), !isStaleRecord(rec) {
            return (false, rec)
        }
        let token = newToken()
        myToken = token
        write(LockRecord(
            sessionPath: sessionPath,
            owner: owner,
            pid: Int(ProcessInfo.processInfo.processIdentifier),
            host: hostName(),
            label: label,
            since: rec?.since ?? Date().timeIntervalSince1970 * 1000,
            token: token
        ))
        return (true, nil)
    }

    @discardableResult
    func takeover() -> LockRecord? {
        let prev = read()
        let token = newToken()
        myToken = token
        write(LockRecord(
            sessionPath: sessionPath,
            owner: owner,
            pid: Int(ProcessInfo.processInfo.processIdentifier),
            host: hostName(),
            label: label,
            since: Date().timeIntervalSince1970 * 1000,
            token: token
        ))
        return prev
    }

    func isLost() -> Bool { if case .lost = state() { return true }; return false }
    func isMine() -> Bool { if case .mine = state() { return true }; return false }

    func release() {
        if case .mine = state() {
            try? FileManager.default.removeItem(atPath: file)
        }
        myToken = nil
    }

    private func write(_ rec: LockRecord) {
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let rand = String(UUID().uuidString.prefix(4))
        let tmp = "\(file).\(ProcessInfo.processInfo.processIdentifier).\(rand).tmp"
        guard let data = try? encodeLockRecord(rec) else { return }
        do {
            try data.write(to: URL(fileURLWithPath: tmp))
            // Atomic replace.
            _ = try FileManager.default.replaceItemAt(URL(fileURLWithPath: file),
                                                      withItemAt: URL(fileURLWithPath: tmp))
        } catch {
            // If replaceItemAt failed because dest didn't exist, fall back to move.
            try? FileManager.default.moveItem(atPath: tmp, toPath: file)
        }
    }
}

/// JSON encoding that omits nil label (matching JS JSON.stringify dropping undefined).
private func encodeLockRecord(_ rec: LockRecord) throws -> Data {
    var obj: [String: Any] = [
        "sessionPath": rec.sessionPath,
        "owner": rec.owner,
        "pid": rec.pid,
        "host": rec.host,
        "since": rec.since,
        "token": rec.token,
    ]
    if let label = rec.label { obj["label"] = label }
    return try JSONSerialization.data(withJSONObject: obj, options: [])
}

/// Survey all locks (for the "who holds what" UI). Cleans up stale orphan files.
func listLocks(lockDir: String = defaultLockDir()) -> [LockRecord] {
    let fm = FileManager.default
    guard let entries = try? fm.contentsOfDirectory(atPath: lockDir) else { return [] }
    var out: [LockRecord] = []
    for f in entries where f.hasSuffix(".json") {
        let full = (lockDir as NSString).appendingPathComponent(f)
        guard let data = fm.contents(atPath: full),
              let rec = try? JSONDecoder().decode(LockRecord.self, from: data) else { continue }
        if isStaleRecord(rec) {
            try? fm.removeItem(atPath: full)
            continue
        }
        out.append(rec)
    }
    return out
}
