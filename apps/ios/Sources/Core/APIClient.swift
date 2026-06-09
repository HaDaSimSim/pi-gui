import Foundation

enum APIError: Error, LocalizedError {
    case http(Int, String)
    case notPaired
    case badURL
    case decoding(String)

    var errorDescription: String? {
        switch self {
        case .http(let code, let msg): return "HTTP \(code): \(msg)"
        case .notPaired: return "Not paired with a backend"
        case .badURL: return "Invalid backend URL"
        case .decoding(let m): return "Decode error: \(m)"
        }
    }
}

// REST client. Every request carries the bearer token (the backend requires it
// for the tailnet Host; localhost is exempt but the app always talks to the host).
actor APIClient {
    private let connection: Connection
    private let token: String
    private let session: URLSession

    init(connection: Connection, token: String) {
        self.connection = connection
        self.token = token
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 30
        cfg.waitsForConnectivity = true
        self.session = URLSession(configuration: cfg)
    }

    private func request(_ path: String, method: String = "GET", body: Encodable? = nil) async throws -> Data {
        guard let url = URL(string: connection.apiBase + path) else { throw APIError.badURL }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONEncoder().encode(AnyEncodable(body))
        }
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw APIError.http(0, "no response") }
        guard (200..<300).contains(http.statusCode) else {
            let msg = String(data: data, encoding: .utf8) ?? ""
            throw APIError.http(http.statusCode, msg)
        }
        return data
    }

    private func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw APIError.decoding(String(describing: error)) }
    }

    // ── Browsing (no runtime) ────────────────────────────────────
    func directories() async throws -> [DirectoryInfo] {
        struct R: Codable { let directories: [DirectoryInfo] }
        return try decode(R.self, await request("/api/directories")).directories
    }

    func sessions(cwd: String) async throws -> [SessionInfo] {
        struct R: Codable { let sessions: [SessionInfo] }
        let q = cwd.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? cwd
        return try decode(R.self, await request("/api/sessions?cwd=\(q)")).sessions
    }

    func sessionDetail(path: String) async throws -> SessionDetail {
        let q = path.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? path
        return try decode(SessionDetail.self, await request("/api/session?path=\(q)"))
    }

    func footer(path: String, cwd: String?) async throws -> FooterData {
        var url = "/api/session/footer?path=\(path.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? path)"
        if let cwd { url += "&cwd=\(cwd.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? cwd)" }
        return try decode(FooterData.self, await request(url))
    }

    func controls(path: String) async throws -> SessionControls {
        let q = path.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? path
        return try decode(SessionControls.self, await request("/api/session/controls?path=\(q)"))
    }

    func commands(path: String) async throws -> [SlashCommand] {
        struct R: Codable { let commands: [SlashCommand] }
        let q = path.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? path
        return try decode(R.self, await request("/api/session/commands?path=\(q)")).commands
    }

    func models() async throws -> [ModelInfo] {
        struct R: Codable { let models: [ModelInfo] }
        return try decode(R.self, await request("/api/models")).models
    }

    func git(cwd: String) async throws -> GitStatus {
        let q = cwd.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? cwd
        return try decode(GitStatus.self, await request("/api/git?cwd=\(q)"))
    }

    // ── Live chat (runtime + lock) ───────────────────────────────
    struct PromptBody: Encodable {
        let path: String
        let message: String
        let force: Bool
        var images: [String]? = nil
        var cwd: String? = nil
        var deliverAs: String? = nil
    }

    func prompt(path: String, message: String, force: Bool = false, cwd: String? = nil, deliverAs: String? = nil) async throws {
        _ = try await request("/api/session/prompt", method: "POST",
                              body: PromptBody(path: path, message: message, force: force, cwd: cwd, deliverAs: deliverAs))
    }

    struct PathBody: Encodable { let path: String }
    struct OpenBody: Encodable { let path: String; let force: Bool }

    func open(path: String, force: Bool = false) async throws {
        _ = try await request("/api/session/open", method: "POST", body: OpenBody(path: path, force: force))
    }

    func abort(path: String) async throws {
        _ = try await request("/api/session/abort", method: "POST", body: PathBody(path: path))
    }

    struct ModelBody: Encodable { let path: String; let provider: String; let id: String; let force: Bool }
    func setModel(path: String, provider: String, id: String, force: Bool = false) async throws -> SessionControls {
        decodeControls(try await request("/api/session/model", method: "POST",
            body: ModelBody(path: path, provider: provider, id: id, force: force)))
    }

    struct ThinkingBody: Encodable { let path: String; let level: String; let force: Bool }
    func setThinking(path: String, level: String, force: Bool = false) async throws -> SessionControls {
        decodeControls(try await request("/api/session/thinking", method: "POST",
            body: ThinkingBody(path: path, level: level, force: force)))
    }

    struct RenameBody: Encodable { let path: String; let name: String; let force: Bool }
    func rename(path: String, name: String, force: Bool = false) async throws -> SessionControls {
        decodeControls(try await request("/api/session/rename", method: "POST",
            body: RenameBody(path: path, name: name, force: force)))
    }

    struct QueueBody: Encodable { let path: String; let steering: [String]; let followUp: [String] }
    func setQueue(path: String, steering: [String], followUp: [String]) async throws {
        _ = try await request("/api/session/queue", method: "POST",
            body: QueueBody(path: path, steering: steering, followUp: followUp))
    }

    struct UiResponseBody: Encodable { let path: String; let id: String; let value: JSONValue }
    func uiResponse(path: String, id: String, value: JSONValue) async throws {
        _ = try await request("/api/session/ui-response", method: "POST",
            body: UiResponseBody(path: path, id: id, value: value))
    }

    struct NewSessionResult: Codable { let path: String; let cwd: String; let id: String; let pending: Bool }
    struct NewSessionBody: Encodable { let cwd: String }
    func newSession(cwd: String) async throws -> NewSessionResult {
        try decode(NewSessionResult.self, await request("/api/session/new", method: "POST", body: NewSessionBody(cwd: cwd)))
    }

    private func decodeControls(_ data: Data) -> SessionControls {
        (try? JSONDecoder().decode(SessionControls.self, from: data))
            ?? SessionControls(live: false, model: nil, thinkingLevel: nil,
                               availableThinkingLevels: [], supportsThinking: false, name: nil, queue: nil)
    }
}

// Type-erasing encodable wrapper so request(body:) accepts any Encodable.
struct AnyEncodable: Encodable {
    private let encodeFn: (Encoder) throws -> Void
    init(_ wrapped: Encodable) { self.encodeFn = wrapped.encode }
    func encode(to encoder: Encoder) throws { try encodeFn(encoder) }
}
