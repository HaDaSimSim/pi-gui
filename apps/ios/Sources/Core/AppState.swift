import Foundation
import SwiftUI

// Root app state: owns the connection store and, when paired, the API client +
// event bus. Views observe this to know whether to show pairing or the browser.
@MainActor
final class AppState: ObservableObject {
    @Published var store = ConnectionStore()
    @Published private(set) var api: APIClient?
    @Published private(set) var bus: EventBus?
    @Published var pairingError: String?

    init() { rebuildClients() }

    var isPaired: Bool { store.isPaired }

    func rebuildClients() {
        if let conn = store.connection, let tok = store.token {
            api = APIClient(connection: conn, token: tok)
            bus = EventBus(connection: conn, token: tok)
        } else {
            api = nil
            bus = nil
        }
    }

    // Handle a scanned QR string: decode, confirm with the backend, persist.
    func handleScannedPayload(_ raw: String) async {
        pairingError = nil
        guard let data = raw.data(using: .utf8),
              let payload = try? JSONDecoder().decode(PairingPayload.self, from: data)
        else {
            pairingError = "Not a valid pi pairing code."
            return
        }
        await confirm(payload: payload)
    }

    private func confirm(payload: PairingPayload) async {
        guard let url = URL(string: payload.url + "/api/remote/pair/confirm") else {
            pairingError = "Invalid backend URL."
            return
        }
        var req = URLRequest(url: url)
        req.setValue("Bearer \(payload.token)", forHTTPHeaderField: "Authorization")
        req.timeoutInterval = 15
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse else {
                pairingError = "No response from backend."
                return
            }
            guard http.statusCode == 200 else {
                let msg = String(data: data, encoding: .utf8) ?? ""
                pairingError = "Pairing failed (\(http.statusCode)). \(msg)"
                return
            }
            // Success — persist the connection + token.
            let conn = Connection(baseURL: payload.url, deviceId: payload.deviceId)
            store.save(connection: conn, token: payload.token)
            rebuildClients()
        } catch {
            pairingError = "Could not reach the backend: \(error.localizedDescription)"
        }
    }

    func unpair() {
        store.clear()
        rebuildClients()
    }
}
