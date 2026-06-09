import SwiftUI

// First-run / unpaired screen: explains the flow and opens the QR scanner.
struct PairingView: View {
    @EnvironmentObject var app: AppState
    @State private var scanning = false

    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            Image(systemName: "qrcode.viewfinder")
                .font(.system(size: 72))
                .foregroundStyle(.tint)
            Text("Connect to pi-gui")
                .font(.title.bold())
            Text("On your Mac, open pi-gui settings → Remote Control → Add device, then scan the QR code shown there.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)

            if let err = app.pairingError {
                Text(err)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
            }

            Button {
                app.pairingError = nil
                scanning = true
            } label: {
                Label("Scan QR Code", systemImage: "camera.viewfinder")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
            }
            .buttonStyle(.borderedProminent)
            .padding(.horizontal, 32)
            Spacer()
        }
        .sheet(isPresented: $scanning) {
            NavigationStack {
                QRScannerView { raw in
                    scanning = false
                    Task { await app.handleScannedPayload(raw) }
                }
                .ignoresSafeArea()
                .navigationTitle("Scan pairing code")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { scanning = false }
                    }
                }
            }
        }
    }
}
