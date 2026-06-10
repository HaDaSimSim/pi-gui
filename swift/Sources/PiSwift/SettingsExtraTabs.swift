import SwiftUI

// Extra settings tabs: pi global settings (settings.json), provider/model management
// (models.json incl. API keys), and a keyboard shortcut cheat sheet.

// MARK: - pi settings (settings.json)

struct PiSettingsTab: View {
    @StateObject private var store = PiSettingsStore()

    private let thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh"]
    private let modes = ["all", "one-at-a-time"]
    private let transports = ["auto", "websocket", "http"]

    var body: some View {
        Form {
            if let err = store.loadError {
                Label(err, systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
            }
            Section("Defaults") {
                LabeledContent("Provider") {
                    TextField("provider", text: bindStr("defaultProvider"))
                        .frame(width: 180).disableAutocorrection(true)
                }
                LabeledContent("Model") {
                    TextField("model id", text: bindStr("defaultModel"))
                        .frame(width: 180).disableAutocorrection(true)
                }
                Picker("Thinking", selection: bindStr("defaultThinkingLevel")) {
                    ForEach(thinkingLevels, id: \.self) { Text($0).tag($0) }
                }
            }
            Section("Behavior") {
                Picker("Transport", selection: bindStr("transport")) {
                    ForEach(transports, id: \.self) { Text($0).tag($0) }
                }
                Picker("Steering mode", selection: bindStr("steeringMode")) {
                    ForEach(modes, id: \.self) { Text($0).tag($0) }
                }
                Picker("Follow-up mode", selection: bindStr("followUpMode")) {
                    ForEach(modes, id: \.self) { Text($0).tag($0) }
                }
                Toggle("Hide thinking blocks", isOn: bindBool("hideThinkingBlock"))
                Toggle("Enable skill commands", isOn: bindBool("enableSkillCommands"))
            }
        }
        .formStyle(.grouped)
        .onAppear { store.load() }
    }

    private func bindStr(_ key: String) -> Binding<String> {
        Binding(get: { store.string(key) }, set: { store.setString(key, $0) })
    }
    private func bindBool(_ key: String) -> Binding<Bool> {
        Binding(get: { store.bool(key) }, set: { store.setBool(key, $0) })
    }
}

// MARK: - Providers (models.json)

struct ProvidersTab: View {
    @StateObject private var store = ProviderStore()
    @State private var newProviderName = ""
    @State private var selected: String?

    var body: some View {
        HSplitView {
            // Provider list.
            VStack(spacing: 0) {
                List(selection: $selected) {
                    ForEach(store.providers) { p in
                        HStack {
                            Text(p.name)
                            Spacer()
                            Text("\(p.models.count)").foregroundStyle(.secondary).font(.caption)
                        }.tag(p.name)
                    }
                }
                Divider()
                HStack(spacing: 4) {
                    TextField("new provider", text: $newProviderName)
                        .textFieldStyle(.roundedBorder).disableAutocorrection(true)
                    Button { store.addProvider(newProviderName); newProviderName = "" } label: {
                        Image(systemName: "plus")
                    }.disabled(newProviderName.isEmpty)
                }
                .padding(6)
            }
            .frame(minWidth: 160, maxWidth: 220)

            // Provider detail.
            if let sel = selected, let p = store.providers.first(where: { $0.name == sel }) {
                ProviderDetail(store: store, provider: p)
            } else {
                ContentUnavailableView("Select a provider", systemImage: "server.rack")
            }
        }
        .onAppear { store.load() }
    }
}

private struct ProviderDetail: View {
    @ObservedObject var store: ProviderStore
    let provider: ProviderStore.ProviderView
    @State private var baseUrl = ""
    @State private var api = ""
    @State private var apiKey = ""

    var body: some View {
        Form {
            Section("Provider: \(provider.name)") {
                LabeledContent("Base URL") {
                    TextField("https://…", text: $baseUrl).disableAutocorrection(true)
                }
                LabeledContent("API type") {
                    TextField("openai-completions", text: $api).disableAutocorrection(true)
                }
                LabeledContent("API key") {
                    // Often "$ENV_VAR" interpolation; a SecureField avoids shoulder-surfing literals.
                    SecureField("$ENV_VAR or literal", text: $apiKey)
                }
                Text("Tip: use $ENV_VAR to read the key from the environment instead of storing a literal.")
                    .font(.caption).foregroundStyle(.secondary)
                HStack {
                    Button("Save") {
                        store.updateProvider(provider.name, baseUrl: baseUrl, api: api, apiKey: apiKey)
                    }.buttonStyle(.borderedProminent)
                    Spacer()
                    Button("Remove provider", role: .destructive) {
                        store.removeProvider(provider.name)
                    }
                }
            }
            Section("Models (\(provider.models.count))") {
                if provider.models.isEmpty {
                    Text("No models").foregroundStyle(.secondary)
                } else {
                    ForEach(provider.models) { m in
                        VStack(alignment: .leading, spacing: 1) {
                            Text(m.name)
                            Text("\(m.modelId) · ctx \(Fmt.tokens(m.contextWindow))")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        .formStyle(.grouped)
        .onAppear { baseUrl = provider.baseUrl; api = provider.api; apiKey = provider.apiKey }
        .onChange(of: provider.name) { _, _ in
            baseUrl = provider.baseUrl; api = provider.api; apiKey = provider.apiKey
        }
    }
}

// MARK: - Shortcut cheat sheet

struct ShortcutsTab: View {
    private let groups: [(String, [(String, String)])] = [
        ("Sessions", [
            ("⇧⌘R", "Refresh sessions"),
            ("⌘W", "Close current tab"),
            ("⌘,", "Open settings"),
        ]),
        ("Composer", [
            ("Return", "Send message"),
            ("⇧Return", "New line"),
            ("/", "Open slash command menu"),
            ("!cmd", "Run a bash command in the session"),
            ("!!cmd", "Run bash, exclude from LLM context"),
        ]),
        ("While streaming", [
            ("Return", "Steer (interrupt with new message)"),
            ("Stop button", "Abort the current turn"),
        ]),
    ]

    var body: some View {
        Form {
            ForEach(groups, id: \.0) { group in
                Section(group.0) {
                    ForEach(group.1, id: \.0) { key, desc in
                        HStack {
                            Text(desc)
                            Spacer()
                            Text(key)
                                .font(.system(.callout, design: .monospaced))
                                .padding(.horizontal, 8).padding(.vertical, 2)
                                .background(.quaternary, in: RoundedRectangle(cornerRadius: 5))
                        }
                    }
                }
            }
        }
        .formStyle(.grouped)
    }
}
