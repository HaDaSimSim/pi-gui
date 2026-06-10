import SwiftUI

// Native-leaning palette. We lean on system materials and semantic colors rather than
// reproducing the web's oklch tokens pixel-for-pixel — the brief is "more Apple-like".
// Status colors mirror the web's semantic meaning so the UX reads the same.

enum Theme {
    // Status semantics (match web meaning).
    static let streaming = Color.orange      // amber: running / retry / warning
    static let success = Color.green         // emerald: live / done / staged-add
    static let info = Color.blue             // sky: in_progress / info / cacheRead
    static let accentViolet = Color.purple   // cacheWrite / merge commit
    static let danger = Color.red            // errors / failed / deletions

    // Token-composition segment colors.
    static let tokInput = Color.blue
    static let tokOutput = Color.green
    static let tokCacheRead = Color.orange
    static let tokCacheWrite = Color.purple

    static func goalEmoji(_ status: String) -> String {
        switch status {
        case "pursuing": return "🎯"
        case "paused": return "⏸"
        case "achieved": return "✅"
        case "blocked": return "🚧"
        case "budget-limited": return "⛔"
        default: return "🎯"
        }
    }

    static func toolIcon(_ name: String) -> String {
        let n = name.lowercased()
        if n.contains("read") || n.contains("view") { return "doc.text" }
        if n.contains("write") || n.contains("edit") { return "square.and.pencil" }
        if n.contains("bash") || n.contains("run") || n.contains("terminal") { return "terminal" }
        if n.contains("grep") || n.contains("find") || n.contains("search") { return "magnifyingglass" }
        if n.contains("fetch") || n.contains("web") { return "globe" }
        if n.contains("ls") || n.contains("tree") || n.contains("glob") { return "folder" }
        if n.contains("todo") || n.contains("task") { return "checklist" }
        return "wrench.and.screwdriver"
    }
}

// MARK: - Formatting helpers (mirror footer.tsx)

enum Fmt {
    /// Token count: <1000 raw, <100k -> "1.2k", <1M -> "123k", else "1.2M".
    static func tokens(_ n: Int) -> String {
        if n < 1000 { return "\(n)" }
        if n < 100_000 { return String(format: "%.1fk", Double(n) / 1000) }
        if n < 1_000_000 { return "\(n / 1000)k" }
        return String(format: "%.1fM", Double(n) / 1_000_000)
    }

    static func cost(_ c: Double) -> String {
        String(format: "$%.2f", c)
    }

    /// Elapsed: 950ms / 3.2s / 2m 15s.
    static func elapsed(_ ms: Double) -> String {
        if ms < 1000 { return "\(Int(ms))ms" }
        let s = ms / 1000
        if s < 60 { return String(format: "%.1fs", s) }
        let m = Int(s) / 60
        let rem = Int(s) % 60
        return "\(m)m \(rem)s"
    }

    /// Shorten a home-prefixed path to ~.
    static func tildePath(_ path: String) -> String {
        let home = ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory()
        if path == home { return "~" }
        if path.hasPrefix(home + "/") { return "~" + path.dropFirst(home.count) }
        return path
    }

    static func dirBasename(_ path: String) -> String {
        (path as NSString).lastPathComponent
    }
}
