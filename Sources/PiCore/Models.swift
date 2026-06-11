import Foundation

// Shared model types used across PiCore, PiUI, and PiMac.
// Cross-platform: no SwiftUI, no AppKit, no Process.

// MARK: - Agent paths

public enum AgentPaths {
  public static var agentDir: String {
    let env = ProcessInfo.processInfo.environment
    return env["PI_AGENT_DIR"]
      ?? (env["HOME"].map { ($0 as NSString).appendingPathComponent(".pi/agent") })
      ?? ".pi/agent"
  }
  public static var sessionsDir: String {
    (agentDir as NSString).appendingPathComponent("sessions")
  }
  public static var settingsPath: String {
    (agentDir as NSString).appendingPathComponent("settings.json")
  }
  public static var modelsPath: String {
    (agentDir as NSString).appendingPathComponent("models.json")
  }

  /// Encode a cwd into its session-dir folder name.
  public static func dirName(forCwd cwd: String) -> String {
    "--" + cwd.replacingOccurrences(of: "/", with: "-") + "--"
  }
  /// Decode a session-dir folder name back into a cwd (best-effort; mirrors restore-path).
  public static func cwd(fromDirName name: String) -> String {
    var s = name
    if s.hasPrefix("--") { s.removeFirst(2) }
    if s.hasSuffix("--") { s.removeLast(2) }
    return "/" + s.replacingOccurrences(of: "-", with: "/")
  }
}

// MARK: - Session summary

public struct SessionSummary: Identifiable {
  public let id: String
  public let path: String
  public let cwd: String
  public let name: String?
  public let modified: Date
  public let sizeBytes: Int
  public let preview: String?

  public init(
    id: String, path: String, cwd: String, name: String?, modified: Date, sizeBytes: Int,
    preview: String?
  ) {
    self.id = id
    self.path = path
    self.cwd = cwd
    self.name = name
    self.modified = modified
    self.sizeBytes = sizeBytes
    self.preview = preview
  }
}

// MARK: - Slash command

public struct SlashCommand: Identifiable {
  public let name: String
  public let description: String?
  public let source: String
  public var argumentHint: String?
  public var id: String { name }

  public init(name: String, description: String?, source: String, argumentHint: String? = nil) {
    self.name = name
    self.description = description
    self.source = source
    self.argumentHint = argumentHint
  }
}

// MARK: - Footer stats

public struct FooterStats {
  public var inputTokens = 0
  public var outputTokens = 0
  public var cacheRead = 0
  public var cacheWrite = 0
  public var totalTokens = 0
  public var cost = 0.0
  public var contextTokens = 0
  public var contextWindow = 0
  public var model: String?
  public var todosDone = 0
  public var todosTotal = 0
  public var goalStatus: String?

  public init() {}
}

// MARK: - App notification

public struct AppNotification: Identifiable {
  public let id = UUID()
  public let text: String
  public let type: String

  public init(text: String, type: String) {
    self.text = text
    self.type = type
  }
}

// MARK: - Live tool

/// An in-flight tool call rendered live during streaming.
public struct LiveTool: Identifiable {
  public let id: String
  public let name: String
  public let args: [String: Any]
  public var done: Bool
  public var isError: Bool

  public init(id: String, name: String, args: [String: Any], done: Bool, isError: Bool) {
    self.id = id
    self.name = name
    self.args = args
    self.done = done
    self.isError = isError
  }
}

// MARK: - Questionnaire

/// A single questionnaire field parsed from the questionnaire tool's args.
public struct QField: Identifiable {
  public let id: String
  public let prompt: String
  public let label: String?
  public let multiSelect: Bool
  public let options: [QOption]

  public init(_ raw: [String: Any]) {
    self.id = (raw["id"] as? String) ?? UUID().uuidString
    self.prompt = (raw["prompt"] as? String) ?? ""
    self.label = raw["label"] as? String
    self.multiSelect = (raw["multiSelect"] as? Bool) ?? false
    self.options = ((raw["options"] as? [[String: Any]]) ?? []).map(QOption.init)
  }
}

public struct QOption: Identifiable {
  public let value: String
  public let label: String
  public let description: String?
  public var id: String { value }

  public init(_ raw: [String: Any]) {
    self.value = (raw["value"] as? String) ?? ""
    self.label = (raw["label"] as? String) ?? (raw["value"] as? String) ?? ""
    self.description = raw["description"] as? String
  }
}

// MARK: - Model option

/// A model option from models.json (provider + id + name).
public struct ModelOption: Identifiable, Hashable {
  public let provider: String
  public let id: String
  public let name: String
  public var spec: String { "\(provider)/\(id)" }

  public init(provider: String, id: String, name: String) {
    self.provider = provider
    self.id = id
    self.name = name
  }

  public static func loadAll() -> [ModelOption] {
    let path = AgentPaths.modelsPath
    guard let data = FileManager.default.contents(atPath: path),
      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let providers = obj["providers"] as? [String: Any]
    else {
      #if DEBUG
        print("[pi-gui] ModelOption.loadAll: failed to read or parse \(path)")
      #endif
      return []
    }
    var out: [ModelOption] = []
    for (provider, val) in providers {
      guard let p = val as? [String: Any], let models = p["models"] as? [[String: Any]] else {
        #if DEBUG
          print("[pi-gui] ModelOption.loadAll: skipping provider '\(provider)' — no 'models' array")
        #endif
        continue
      }
      for m in models {
        guard let id = m["id"] as? String else { continue }
        out.append(ModelOption(provider: provider, id: id, name: (m["name"] as? String) ?? id))
      }
    }
    #if DEBUG
      print(
        "[pi-gui] ModelOption.loadAll: loaded \(out.count) models from \(providers.count) providers (\(providers.keys.sorted().joined(separator: ", ")))"
      )
    #endif
    return out.sorted { $0.spec < $1.spec }
  }
}

// MARK: - App settings keys

/// Namespaced UserDefaults keys. Kept as raw string constants so @AppStorage and
/// the plain UserDefaults readers agree exactly.
public enum AppSettingsKeys {
  public static let lang = "piswift.lang"
  public static let themeMode = "piswift.themeMode"
  public static let reduceMotion = "piswift.reduceMotion"
}

// MARK: - Formatting helpers (mirror footer.tsx)

public enum Fmt {
  /// Token count: <1000 raw, <100k -> "1.2k", <1M -> "123k", else "1.2M".
  public static func tokens(_ n: Int) -> String {
    if n < 1000 { return "\(n)" }
    if n < 100_000 { return String(format: "%.1fk", Double(n) / 1000) }
    if n < 1_000_000 { return "\(n / 1000)k" }
    return String(format: "%.1fM", Double(n) / 1_000_000)
  }

  public static func cost(_ c: Double) -> String {
    String(format: "$%.2f", c)
  }

  /// Elapsed: 950ms / 3.2s / 2m 15s.
  public static func elapsed(_ ms: Double) -> String {
    if ms < 1000 { return "\(Int(ms))ms" }
    let s = ms / 1000
    if s < 60 { return String(format: "%.1fs", s) }
    let m = Int(s) / 60
    let rem = Int(s) % 60
    return "\(m)m \(rem)s"
  }

  /// Shorten a home-prefixed path to ~.
  public static func tildePath(_ path: String) -> String {
    let home = ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory()
    if path == home { return "~" }
    if path.hasPrefix(home + "/") { return "~" + path.dropFirst(home.count) }
    return path
  }

  public static func dirBasename(_ path: String) -> String {
    (path as NSString).lastPathComponent
  }
}

// MARK: - ANSI stripping

public enum ANSI {
  /// Strip ANSI SGR escape sequences (e.g. \u001b[38;2;102;102;102m).
  public static func strip(_ s: String) -> String {
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

// MARK: - Array safe subscript

extension Array {
  public subscript(safe index: Int) -> Element? {
    indices.contains(index) ? self[index] : nil
  }
}
