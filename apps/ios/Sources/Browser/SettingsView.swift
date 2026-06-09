import SwiftUI

// App settings: shows the paired backend and lets the user unpair.
struct SettingsView: View {
    @EnvironmentObject var app: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var confirmUnpair = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Backend") {
                    LabeledContent("Host", value: app.store.connection?.host ?? "—")
                    LabeledContent("URL", value: app.store.connection?.baseURL ?? "—")
                }
                Section {
                    Button(role: .destructive) {
                        confirmUnpair = true
                    } label: {
                        Label("Unpair this device", systemImage: "xmark.circle")
                    }
                } footer: {
                    Text("Removes the stored token. You'll need to scan a new QR code from pi-gui to reconnect.")
                }
                Section("About") {
                    LabeledContent("App", value: "pi for iOS")
                    LabeledContent("Connection", value: "Tailscale / local network")
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .confirmationDialog("Unpair this device?", isPresented: $confirmUnpair, titleVisibility: .visible) {
                Button("Unpair", role: .destructive) {
                    app.unpair()
                    dismiss()
                }
                Button("Cancel", role: .cancel) {}
            }
        }
    }
}
