import PiCore
import SwiftUI

// Native-leaning palette. We lean on system materials and semantic colors rather than
// reproducing the web's oklch tokens pixel-for-pixel — the brief is "more Apple-like".
// Status colors mirror the web's semantic meaning so the UX reads the same.

public enum Theme {
  // Status semantics (match web meaning).
  static let streaming = Color.orange  // amber: running / retry / warning
  static let success = Color.green  // emerald: live / done / staged-add
  static let info = Color.blue  // sky: in_progress / info / cacheRead
  static let accentViolet = Color.purple  // cacheWrite / merge commit
  static let danger = Color.red  // errors / failed / deletions

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
