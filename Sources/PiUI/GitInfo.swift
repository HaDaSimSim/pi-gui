import Foundation
import PiCore

// Read-only git via the git CLI (array args, never shell). Mirrors the subset of server/git.ts
// the UI shows: branch/upstream/ahead-behind, file changes with porcelain codes, recent commit
// graph, branch list, and per-commit detail (numstat).
struct GitFileChange: Identifiable {
  let path: String
  let code: String  // single-letter status: M A D R ? (display)
  var id: String { code + path }
}

struct GitCommit: Identifiable {
  let hash: String
  let shortHash: String
  let subject: String
  let author: String
  let relTime: String
  let refs: [String]
  let parents: [String]
  var isMerge: Bool { parents.count > 1 }
  var id: String { hash }
}

struct GitBranchInfo: Identifiable {
  let name: String
  let current: Bool
  let upstream: String?
  var id: String { name }
}

struct GitCommitFile: Identifiable {
  let path: String
  let added: Int
  let deleted: Int
  var id: String { path }
}

struct GitCommitDetail {
  let hash: String
  let shortHash: String
  let subject: String
  let body: String
  let author: String
  let authorEmail: String
  let relTime: String
  let parents: [String]
  let files: [GitCommitFile]
  let insertions: Int
  let deletions: Int
}

struct GitInfo {
  var isRepo = false
  var branch: String?
  var detachedHead: String?
  var upstream: String?
  var ahead = 0
  var behind = 0
  var staged: [GitFileChange] = []
  var unstaged: [GitFileChange] = []
  var untracked: [GitFileChange] = []
  var commits: [GitCommit] = []
  var branches: [GitBranchInfo] = []

  static func load(cwd: String, logLimit: Int = 50) -> GitInfo {
    var info = GitInfo()
    guard
      run(["rev-parse", "--is-inside-work-tree"], cwd: cwd)
        .trimmingCharacters(in: .whitespacesAndNewlines) == "true"
    else { return info }
    info.isRepo = true

    let branch = run(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd: cwd)
      .trimmingCharacters(in: .whitespacesAndNewlines)
    if branch.isEmpty {
      info.detachedHead = run(["rev-parse", "--short", "HEAD"], cwd: cwd)
        .trimmingCharacters(in: .whitespacesAndNewlines)
    } else {
      info.branch = branch
    }

    let up = run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], cwd: cwd)
      .trimmingCharacters(in: .whitespacesAndNewlines)
    if !up.isEmpty && !up.lowercased().contains("fatal") { info.upstream = up }

    let counts = run(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], cwd: cwd)
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .split(whereSeparator: { $0 == "\t" || $0 == " " })
    if counts.count == 2 {
      info.ahead = Int(counts[0]) ?? 0
      info.behind = Int(counts[1]) ?? 0
    }

    for line in run(["status", "--porcelain"], cwd: cwd).split(separator: "\n") {
      guard line.count >= 3 else { continue }
      let chars = Array(line)
      let x = chars[0]
      let y = chars[1]
      var path = String(line.dropFirst(3))
      if let r = path.range(of: " -> ") { path = String(path[r.upperBound...]) }  // rename → new path
      if x == "?" && y == "?" {
        info.untracked.append(GitFileChange(path: path, code: "?"))
        continue
      }
      if x != " " && x != "?" { info.staged.append(GitFileChange(path: path, code: String(x))) }
      if y != " " && y != "?" { info.unstaged.append(GitFileChange(path: path, code: String(y))) }
    }

    // Commit graph: hash, short, subject, author, relTime, refs, parents.
    let us = "\u{1f}"
    let logFmt = ["%H", "%h", "%s", "%an", "%cr", "%D", "%P"].joined(separator: us)
    let logOut = run(
      ["log", "-\(logLimit)", "--pretty=format:\(logFmt)", "--all", "--date-order"], cwd: cwd)
    for line in logOut.split(separator: "\n") {
      let f = line.components(separatedBy: us)
      guard f.count >= 7 else { continue }
      let refs = f[5].split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter {
        !$0.isEmpty
      }
      let parents = f[6].split(separator: " ").map(String.init)
      info.commits.append(
        GitCommit(
          hash: f[0], shortHash: f[1], subject: f[2],
          author: f[3], relTime: f[4], refs: refs, parents: parents))
    }

    // Branches.
    let brFmt = ["%(refname:short)", "%(HEAD)", "%(upstream:short)"].joined(separator: us)
    for line in run(["for-each-ref", "--format=\(brFmt)", "refs/heads"], cwd: cwd).split(
      separator: "\n")
    {
      let f = line.components(separatedBy: us)
      guard f.count >= 2 else { continue }
      info.branches.append(
        GitBranchInfo(
          name: f[0], current: f[1] == "*",
          upstream: f.count > 2 && !f[2].isEmpty ? f[2] : nil))
    }
    return info
  }

  /// Per-commit detail via `git show --numstat`. Hash is validated to avoid arg injection.
  static func commitDetail(cwd: String, hash: String) -> GitCommitDetail? {
    guard hash.range(of: "^[0-9a-fA-F]{4,40}$", options: .regularExpression) != nil else {
      return nil
    }
    let us = "\u{1f}"
    let rs = "\u{1e}"
    let fmt = ["%H", "%h", "%s", "%b", "%an", "%ae", "%cr", "%P"].joined(separator: us) + rs
    let out = run(["show", "--no-color", "--numstat", "--format=\(fmt)", hash], cwd: cwd)
    guard let sep = out.range(of: rs) else { return nil }
    let meta = String(out[..<sep.lowerBound]).components(separatedBy: us)
    guard meta.count >= 8 else { return nil }
    var files: [GitCommitFile] = []
    var ins = 0
    var del = 0
    for line in out[sep.upperBound...].split(separator: "\n") {
      let parts = line.split(separator: "\t", maxSplits: 2, omittingEmptySubsequences: false).map(
        String.init)
      guard parts.count == 3 else { continue }
      let a = Int(parts[0]) ?? 0
      let d = Int(parts[1]) ?? 0
      ins += a
      del += d
      files.append(GitCommitFile(path: parts[2], added: a, deleted: d))
    }
    return GitCommitDetail(
      hash: meta[0], shortHash: meta[1], subject: meta[2], body: meta[3],
      author: meta[4], authorEmail: meta[5], relTime: meta[6],
      parents: meta[7].split(separator: " ").map(String.init),
      files: files, insertions: ins, deletions: del)
  }

  private static func run(_ args: [String], cwd: String) -> String {
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: "/usr/bin/git")
    proc.arguments = args
    proc.currentDirectoryURL = URL(fileURLWithPath: cwd)
    let out = Pipe()
    proc.standardOutput = out
    proc.standardError = Pipe()
    do {
      try proc.run()
      let data = out.fileHandleForReading.readDataToEndOfFile()
      proc.waitUntilExit()
      return String(data: data, encoding: .utf8) ?? ""
    } catch { return "" }
  }
}
