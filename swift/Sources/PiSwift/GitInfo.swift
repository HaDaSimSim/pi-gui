import Foundation

// Minimal read-only git status via the git CLI (execFile-style, array args, never shell).
// Mirrors the subset of server/git.ts the UI shows: branch, ahead/behind, file changes.
struct GitInfo {
    var isRepo = false
    var branch: String?
    var ahead = 0
    var behind = 0
    var staged: [String] = []
    var unstaged: [String] = []
    var untracked: [String] = []

    static func load(cwd: String) -> GitInfo {
        var info = GitInfo()
        guard run(["rev-parse", "--is-inside-work-tree"], cwd: cwd).trimmingCharacters(in: .whitespacesAndNewlines) == "true" else {
            return info
        }
        info.isRepo = true
        let branch = run(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd: cwd)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        info.branch = branch.isEmpty ? nil : branch

        let counts = run(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], cwd: cwd)
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .split(whereSeparator: { $0 == "\t" || $0 == " " })
        if counts.count == 2 { info.ahead = Int(counts[0]) ?? 0; info.behind = Int(counts[1]) ?? 0 }

        for line in run(["status", "--porcelain"], cwd: cwd).split(separator: "\n") {
            guard line.count >= 3 else { continue }
            let x = line[line.startIndex]
            let y = line[line.index(after: line.startIndex)]
            let path = String(line.dropFirst(3))
            if x == "?" && y == "?" { info.untracked.append(path); continue }
            if x != " " && x != "?" { info.staged.append(path) }
            if y != " " && y != "?" { info.unstaged.append(path) }
        }
        return info
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
            proc.waitUntilExit()
            let data = out.fileHandleForReading.readDataToEndOfFile()
            return String(data: data, encoding: .utf8) ?? ""
        } catch { return "" }
    }
}
