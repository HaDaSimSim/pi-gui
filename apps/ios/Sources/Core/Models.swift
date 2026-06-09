import Foundation

// Data models mirroring server/index.ts + web/api.ts response shapes.
// Only the fields the app renders are decoded; unknown fields are ignored.

struct DirectoryInfo: Codable, Identifiable, Hashable {
    let cwd: String
    let sessionCount: Int
    let lastModified: String
    var id: String { cwd }
}

struct SessionInfo: Codable, Identifiable, Hashable {
    let path: String
    let id: String
    let name: String?
    let firstMessage: String
    let messageCount: Int
    let created: String
    let modified: String
    let live: Bool

    var displayName: String {
        if let n = name, !n.isEmpty { return n }
        let trimmed = firstMessage.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { return String(trimmed.prefix(60)) }
        return "(untitled)"
    }
}

struct ModelInfo: Codable, Hashable {
    let provider: String
    let id: String
    let name: String
}

// A session entry from getEntries() — loosely typed (decoded via JSONValue).
struct SessionDetail: Codable {
    let path: String
    let cwd: String
    let name: String?
    let leafId: String?
    let entries: [JSONValue]
    let live: Bool
}

struct FooterTokens: Codable, Hashable {
    let input: Int
    let output: Int
    let cacheRead: Int
    let cacheWrite: Int
    let total: Int
}

struct FooterData: Codable {
    let cwd: String
    let name: String?
    let branch: String?
    let tokens: FooterTokens
    let cost: Double
    let live: Bool
    let model: ModelInfo?
    let thinkingLevel: String?
    let supportsThinking: Bool?
    let contextUsage: ContextUsage?
}

struct ContextUsage: Codable, Hashable {
    let tokens: Int?
    let contextWindow: Int
    let percent: Double?
}

struct SessionControls: Codable {
    let live: Bool
    let model: ModelInfo?
    let thinkingLevel: String?
    let availableThinkingLevels: [String]
    let supportsThinking: Bool
    let name: String?
    let queue: Queue?

    struct Queue: Codable {
        let steering: [String]
        let followUp: [String]
    }
}

struct SlashCommand: Codable, Identifiable, Hashable {
    let name: String
    let description: String?
    let argumentHint: String?
    let source: String
    var id: String { name }
}

// Git
struct GitFileChange: Codable, Identifiable, Hashable {
    let path: String
    let index: String
    let work: String
    let untracked: Bool
    var id: String { path }
}

struct GitBranch: Codable, Identifiable, Hashable {
    let name: String
    let current: Bool
    let upstream: String?
    var id: String { name }
}

struct GitCommit: Codable, Identifiable, Hashable {
    let hash: String
    let shortHash: String
    let subject: String
    let author: String
    let relTime: String
    let refs: String
    let parents: [String]
    var id: String { hash }
}

struct GitStatus: Codable {
    let isRepo: Bool
    let branch: String?
    let head: String?
    let upstream: String?
    let ahead: Int
    let behind: Int
    let staged: [GitFileChange]
    let unstaged: [GitFileChange]
    let untracked: [GitFileChange]
    let branches: [GitBranch]
    let commits: [GitCommit]
}

// Remote status (for the desktop's own settings — also useful for showing host).
struct RemoteDevice: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let status: String
    let createdAt: Double
    let lastSeenAt: Double?
}
