import Foundation

// Connection config: the backend base URL (https://<host>.<tailnet>.ts.net) and
// the per-device bearer token. Persisted in UserDefaults (URL) + Keychain (token).
struct Connection: Codable, Equatable {
    var baseURL: String          // e.g. "https://mac.tailnet.ts.net"
    var deviceId: String

    var apiBase: String { baseURL }
    var wsBase: String {
        if baseURL.hasPrefix("https://") {
            return "wss://" + baseURL.dropFirst("https://".count)
        }
        if baseURL.hasPrefix("http://") {
            return "ws://" + baseURL.dropFirst("http://".count)
        }
        return baseURL
    }

    var host: String? { URL(string: baseURL)?.host }
}

// Stores the active connection. The token lives in the Keychain keyed by deviceId.
@MainActor
final class ConnectionStore: ObservableObject {
    @Published private(set) var connection: Connection?
    @Published private(set) var token: String?

    private let defaultsKey = "pi.connection"

    init() { load() }

    var isPaired: Bool { connection != nil && token != nil }

    func load() {
        guard
            let data = UserDefaults.standard.data(forKey: defaultsKey),
            let conn = try? JSONDecoder().decode(Connection.self, from: data)
        else { return }
        connection = conn
        token = Keychain.read(account: conn.deviceId)
    }

    func save(connection conn: Connection, token tok: String) {
        if let data = try? JSONEncoder().encode(conn) {
            UserDefaults.standard.set(data, forKey: defaultsKey)
        }
        Keychain.save(account: conn.deviceId, value: tok)
        connection = conn
        token = tok
    }

    func clear() {
        if let id = connection?.deviceId { Keychain.delete(account: id) }
        UserDefaults.standard.removeObject(forKey: defaultsKey)
        connection = nil
        token = nil
    }
}
