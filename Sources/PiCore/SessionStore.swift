import Foundation

// Session directory + listing. Reimplements SessionManager.listAll/list/getCwd/getSessionName
// as pure file reads. Directory naming convention (verified): the agent sessions root contains
// one dir per cwd, named "--" + cwd with "/" replaced by "-" + "--".

public struct SessionStore {

  public init() {}

  /// All cwd directories that have sessions, most-recently-modified first.
  public func directories() -> [(
    cwd: String, dirName: String, path: String, modified: Date, count: Int
  )] {
    let fm = FileManager.default
    let root = AgentPaths.sessionsDir
    guard let names = try? fm.contentsOfDirectory(atPath: root) else { return [] }
    var out: [(String, String, String, Date, Int)] = []
    for name in names where name.hasPrefix("--") {
      let full = (root as NSString).appendingPathComponent(name)
      var isDir: ObjCBool = false
      guard fm.fileExists(atPath: full, isDirectory: &isDir), isDir.boolValue else { continue }
      let files =
        (try? fm.contentsOfDirectory(atPath: full))?.filter { $0.hasSuffix(".jsonl") } ?? []
      if files.isEmpty { continue }
      // Use the most recent session file's mtime (not the directory's mtime,
      // which only updates on file add/remove, not on content writes).
      var latestMtime: Date = .distantPast
      for f in files {
        let fpath = (full as NSString).appendingPathComponent(f)
        if let ft = (try? fm.attributesOfItem(atPath: fpath)[.modificationDate] as? Date),
          ft > latestMtime
        {
          latestMtime = ft
        }
      }
      let cwd = trueCwd(inDir: full, files: files) ?? AgentPaths.cwd(fromDirName: name)
      out.append((cwd, name, full, latestMtime, files.count))
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
  public func sessions(forCwd cwd: String) -> [SessionSummary] {
    let direct = (AgentPaths.sessionsDir as NSString).appendingPathComponent(
      AgentPaths.dirName(forCwd: cwd))
    if FileManager.default.fileExists(atPath: direct) {
      let s = sessions(inDir: direct)
      if let first = s.first, first.cwd == cwd { return s }
    }
    if let match = directories().first(where: { $0.cwd == cwd }) {
      return sessions(inDir: match.path)
    }
    return sessions(inDir: direct)
  }

  public func sessions(inDir dir: String) -> [SessionSummary] {
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
      out.append(
        SessionSummary(
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

  /// Scan the first chunk of a session for a display name and the first user message preview.
  private func cheapMeta(path: String) -> (name: String?, preview: String?) {
    guard let data = try? SessionFile.tailHead(path: path, maxBytes: 256 * 1024) else {
      return (nil, nil)
    }
    let entries = SessionFile.parseEntries(data)
    var name: String?
    var preview: String?
    for e in entries {
      if name == nil, let n = (e.raw["name"] as? String) ?? (e.raw["sessionName"] as? String) {
        name = n
      }
      if preview == nil, e.type == "message",
        let msg = e.raw["message"] as? [String: Any],
        (msg["role"] as? String) == "user"
      {
        preview = SessionStore.extractText(msg["content"])
      }
      if name != nil && preview != nil { break }
    }
    return (name, preview)
  }

  public static func extractText(_ content: Any?) -> String? {
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
