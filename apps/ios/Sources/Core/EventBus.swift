import Foundation

// Single WebSocket to /ws, multiplexing session subscriptions — mirrors
// web/event-bus.ts. Client sends { type:"subscribe", paths:[...] }; server
// streams { path, event }. Auto-reconnects with backoff and restores subs.
//
// The bearer token is sent as an Authorization header on the upgrade request
// (URLSessionWebSocketTask supports this; browsers can't, which is why the web
// uses localhost-exempt auth). No token in the query string.
actor EventBus {
    private let connection: Connection
    private let token: String
    private var task: URLSessionWebSocketTask?
    private var session: URLSession!
    private var listeners: [String: [(JSONValue) -> Void]] = [:]
    private var backoff: UInt64 = 500_000_000 // 0.5s in ns
    private var connecting = false

    init(connection: Connection, token: String) {
        self.connection = connection
        self.token = token
        self.session = URLSession(configuration: .default)
    }

    // Subscribe a handler to one session path. Returns an unsubscribe token id.
    func subscribe(path: String, handler: @escaping (JSONValue) -> Void) {
        listeners[path, default: []].append(handler)
        Task { await connectIfNeeded(); await sendSubscriptions() }
    }

    func unsubscribeAll(path: String) {
        listeners[path] = nil
        Task { await sendSubscriptions() }
    }

    func shutdown() {
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        listeners.removeAll()
    }

    private func connectIfNeeded() async {
        guard task == nil, !connecting else { return }
        guard let url = URL(string: connection.wsBase + "/ws") else { return }
        connecting = true
        var req = URLRequest(url: url)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let t = session.webSocketTask(with: req)
        task = t
        t.resume()
        connecting = false
        backoff = 500_000_000
        await sendSubscriptions()
        await receiveLoop(t)
    }

    private func sendSubscriptions() async {
        guard let t = task else { return }
        let paths = Array(listeners.keys)
        let payload: [String: Any] = ["type": "subscribe", "paths": paths]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let str = String(data: data, encoding: .utf8) else { return }
        try? await t.send(.string(str))
    }

    private func receiveLoop(_ t: URLSessionWebSocketTask) async {
        do {
            while true {
                let msg = try await t.receive()
                switch msg {
                case .string(let s): dispatch(s)
                case .data(let d): if let s = String(data: d, encoding: .utf8) { dispatch(s) }
                @unknown default: break
                }
            }
        } catch {
            // Connection dropped — reconnect if we still have listeners.
            task = nil
            if !listeners.isEmpty {
                try? await Task.sleep(nanoseconds: backoff)
                backoff = min(backoff * 2, 5_000_000_000)
                await connectIfNeeded()
            }
        }
    }

    private func dispatch(_ raw: String) {
        guard let data = raw.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let path = obj["path"] as? String
        else { return }
        let event = JSONValue.from(obj["event"] ?? NSNull())
        for handler in listeners[path] ?? [] {
            handler(event)
        }
    }
}
