import Foundation

// App configuration: locate the pi binary and default model/thinking from settings.json.
// We never spawn pi for browsing — only RuntimeSession spawns it on prompt/open.

struct PiConfig {
    let piPath: String
    let defaultProvider: String?
    let defaultModel: String?
    let defaultThinkingLevel: String?

    var defaultModelSpec: String? {
        guard let p = defaultProvider, let m = defaultModel else { return nil }
        return "\(p)/\(m)"
    }

    static func discover() -> PiConfig {
        let piPath = Self.findPi()
        var provider: String?
        var model: String?
        var thinking: String?
        if let data = FileManager.default.contents(atPath: AgentPaths.settingsPath),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            provider = obj["defaultProvider"] as? String
            model = obj["defaultModel"] as? String
            thinking = obj["defaultThinkingLevel"] as? String
        }
        return PiConfig(piPath: piPath, defaultProvider: provider, defaultModel: model, defaultThinkingLevel: thinking)
    }

    /// Find the pi binary. Order: PI_BIN env, common nvm/node bin dirs, login-shell `which pi`,
    /// then PATH. We resolve eagerly so spawns from a GUI (no login PATH) still work.
    private static func findPi() -> String {
        let fm = FileManager.default
        if let env = ProcessInfo.processInfo.environment["PI_BIN"], fm.isExecutableFile(atPath: env) {
            return env
        }
        // Try `which pi` via a login shell (GUI apps don't inherit the login PATH).
        if let viaShell = whichViaLoginShell(), fm.isExecutableFile(atPath: viaShell) {
            return viaShell
        }
        // Common locations.
        let home = ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory()
        let candidates = [
            "/opt/homebrew/bin/pi",
            "/usr/local/bin/pi",
            "\(home)/.nvm/versions/node",  // scanned below
        ]
        for c in candidates where !c.contains(".nvm") && fm.isExecutableFile(atPath: c) {
            return c
        }
        // Scan nvm node versions for a pi shim.
        let nvm = "\(home)/.nvm/versions/node"
        if let versions = try? fm.contentsOfDirectory(atPath: nvm) {
            for v in versions.sorted(by: >) {
                let p = "\(nvm)/\(v)/bin/pi"
                if fm.isExecutableFile(atPath: p) { return p }
            }
        }
        return "pi" // last resort: rely on PATH
    }

    private static func whichViaLoginShell() -> String? {
        let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: shell)
        proc.arguments = ["-ilc", "command -v pi"]
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = Pipe()
        do {
            try proc.run()
            proc.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let out = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
            if let out, !out.isEmpty, out.hasPrefix("/") { return out }
        } catch {}
        return nil
    }
}

/// A model option from models.json (provider + id + name).
struct ModelOption: Identifiable, Hashable {
    let provider: String
    let id: String
    let name: String
    var spec: String { "\(provider)/\(id)" }

    static func loadAll() -> [ModelOption] {
        guard let data = FileManager.default.contents(atPath: AgentPaths.modelsPath),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let providers = obj["providers"] as? [String: Any] else { return [] }
        var out: [ModelOption] = []
        for (provider, val) in providers {
            guard let p = val as? [String: Any], let models = p["models"] as? [[String: Any]] else { continue }
            for m in models {
                guard let id = m["id"] as? String else { continue }
                out.append(ModelOption(provider: provider, id: id, name: (m["name"] as? String) ?? id))
            }
        }
        return out.sorted { $0.spec < $1.spec }
    }
}
