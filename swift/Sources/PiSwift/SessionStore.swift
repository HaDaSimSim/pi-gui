import Foundation

// Session directory + listing. Reimplements SessionManager.listAll/list/getCwd/getSessionName
// as pure file reads. Directory naming convention (verified): the agent sessions root contains
// one dir per cwd, named "--" + cwd with "/" replaced by "-" + "--".
//
//   /Users/mingeon/projects/pi-gui  ->  --Users-mingeon-projects-pi-gui--
//
// Each dir holds <ISO-timestamp>_<uuid>.jsonl session files.

struct SessionSummary: Identifiable {
    let id: String              // session uuid (from filename or header)
    let path: String
    let cwd: String
    let name: String?           // display name if set
    let modified: Date
    let sizeBytes: Int
    let preview: String?        // first user message text, for the list
}

enum AgentPaths {
    static var agentDir: String {
        let env = ProcessInfo.processInfo.environment
        return env["PI_AGENT_DIR"]
            ?? (env["HOME"].map { ($0 as NSString).appendingPathComponent(".pi/agent") })
            ?? ".pi/agent"
    }
    static var sessionsDir: String { (agentDir as NSString).appendingPathComponent("sessions") }
    static var settingsPath: String { (agentDir as NSString).appendingPathComponent("settings.json") }
    static var modelsPath: String { (agentDir as NSString).appendingPathComponent("models.json") }

    /// Encode a cwd into its session-dir folder name.
    static func dirName(forCwd cwd: String) -> String {
        "--" + cwd.replacingOccurrences(of: "/", with: "-") + "--"
    }
    /// Decode a session-dir folder name back into a cwd (best-effort; mirrors restore-path).
    static func cwd(fromDirName name: String) -> String {
        var s = name
        if s.hasPrefix("--") { s.removeFirst(2) }
        if s.hasSuffix("--") { s.removeLast(2) }
        return "/" + s.replacingOccurrences(of: "-", with: "/")
    }
}

struct SessionStore {

    /// All cwd directories that have sessions, most-recently-modified first.
    func directories() -> [(cwd: String, dirName: String, path: String, modified: Date, count: Int)] {
        let fm = FileManager.default
        let root = AgentPaths.sessionsDir
        guard let names = try? fm.contentsOfDirectory(atPath: root) else { return [] }
        var out: [(String, String, String, Date, Int)] = []
        for name in names where name.hasPrefix("--") {
            let full = (root as NSString).appendingPathComponent(name)
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: full, isDirectory: &isDir), isDir.boolValue else { continue }
            let files = (try? fm.contentsOfDirectory(atPath: full))?.filter { $0.hasSuffix(".jsonl") } ?? []
            if files.isEmpty { continue }
            let mtime = (try? fm.attributesOfItem(atPath: full)[.modificationDate] as? Date) ?? nil
            // The dir-name encoding ("/"->"-") is lossy (real paths contain hyphens), so read the
            // true cwd from a session header instead of decoding the folder name.
            let cwd = trueCwd(inDir: full, files: files) ?? AgentPaths.cwd(fromDirName: name)
            out.append((cwd, name, full, mtime ?? .distantPast, files.count))
        }
        return out.sorted { $0.3 > $1.3 }
    }

    /// Read the cwd from the header of any session file in the directory.
    private func trueCwd(inDir dir: String, files: [String]) -> String? {
        for f in files.prefix(3) {
            let full = (dir as NSString).appendingPathComponent(f)
            if let h = try? SessionFile(path: full).header(), let cwd = h.cwd, !cwd.isEmpty {
                return cwd
            }
        }
        return nil
    }

    /// Session summaries for a given cwd, most-recent first. Resolves the (possibly lossy)
    /// dir name by matching the true cwd from directory headers.
    func sessions(forCwd cwd: String) -> [SessionSummary] {
        // First try the direct encoding (fast path).
        let direct = (AgentPaths.sessionsDir as NSString).appendingPathComponent(AgentPaths.dirName(forCwd: cwd))
        if FileManager.default.fileExists(atPath: direct) {
            let s = sessions(inDir: direct)
            if let first = s.first, first.cwd == cwd { return s }
        }
        // Fall back to matching the true cwd across all directories.
        if let match = directories().first(where: { $0.cwd == cwd }) {
            return sessions(inDir: match.path)
        }
        return sessions(inDir: direct)
    }

    func sessions(inDir dir: String) -> [SessionSummary] {
        let fm = FileManager.default
        guard let files = try? fm.contentsOfDirectory(atPath: dir) else { return [] }
        var out: [SessionSummary] = []
        for f in files where f.hasSuffix(".jsonl") {
            let full = (dir as NSString).appendingPathComponent(f)
            let attrs = try? fm.attributesOfItem(atPath: full)
            let modified = (attrs?[.modificationDate] as? Date) ?? .distantPast
            let size = (attrs?[.size] as? Int) ?? 0
            let sf = SessionFile(path: full)
            let header = try? sf.header()
            let meta = cheapMeta(path: full)
            out.append(SessionSummary(
                id: header?.id ?? f,
                path: full,
                cwd: header?.cwd ?? AgentPaths.cwd(fromDirName: (dir as NSString).lastPathComponent),
                name: meta.name,
                modified: modified,
                sizeBytes: size,
                preview: meta.preview
            ))
        }
        return out.sorted { $0.modified > $1.modified }
    }

    /// Scan the first chunk of a session for a display name (session_name custom entry or
    /// set via state) and the first user message preview. Reads at most ~256KB.
    private func cheapMeta(path: String) -> (name: String?, preview: String?) {
        guard let data = try? SessionFile.tailHead(path: path, maxBytes: 256 * 1024) else {
            return (nil, nil)
        }
        let entries = SessionFile.parseEntries(data)
        var name: String?
        var preview: String?
        for e in entries {
            // Session name can arrive as a custom entry or a dedicated field; check common shapes.
            if name == nil, let n = (e.raw["name"] as? String) ?? (e.raw["sessionName"] as? String) {
                name = n
            }
            if preview == nil, e.type == "message",
               let msg = e.raw["message"] as? [String: Any],
               (msg["role"] as? String) == "user" {
                preview = SessionStore.extractText(msg["content"])
            }
            if name != nil && preview != nil { break }
        }
        return (name, preview)
    }

    static func extractText(_ content: Any?) -> String? {
        if let s = content as? String { return s }
        if let arr = content as? [[String: Any]] {
            let texts = arr.compactMap { block -> String? in
                if (block["type"] as? String) == "text" { return block["text"] as? String }
                return nil
            }
            return texts.isEmpty ? nil : texts.joined(separator: "\n")
        }
        return nil
    }
}

extension SessionFile {
    /// Aggregate footer stats over the WHOLE file by streaming line-by-line, so token/cost
    /// totals are correct even when scrollback only shows a tail window. Memory stays bounded.
    func fullFooter() throws -> FooterStats {
        guard let fh = FileHandle(forReadingAtPath: path) else { throw SessionParseError.notFound }
        defer { try? fh.close() }
        var stats = FooterStats()
        var buffer = Data()
        func handle(_ lineData: Data) {
            guard !lineData.isEmpty,
                  let obj = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any] else { return }
            Transcript.accumulateFooter(obj, into: &stats)
        }
        while true {
            let chunk = fh.readData(ofLength: 1024 * 1024)
            if chunk.isEmpty { break }
            buffer.append(chunk)
            while let nl = buffer.firstIndex(of: 0x0A) {
                var line = buffer.subdata(in: buffer.startIndex..<nl)
                buffer = buffer.subdata(in: buffer.index(after: nl)..<buffer.endIndex)
                if line.last == 0x0D { line = line.dropLast() }
                handle(line)
            }
        }
        handle(buffer)
        return stats
    }

    /// Read up to maxBytes from the START of the file (for cheap metadata scans).
    static func tailHead(path: String, maxBytes: Int) throws -> Data {
        guard let fh = FileHandle(forReadingAtPath: path) else { throw SessionParseError.notFound }
        defer { try? fh.close() }
        return fh.readData(ofLength: maxBytes)
    }
}
