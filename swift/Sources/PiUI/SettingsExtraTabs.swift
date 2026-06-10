import PiCore
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
    NavigationSplitView {
      List(selection: $selected) {
        ForEach(store.providers) { p in
          NavigationLink(value: p.name) {
            HStack {
              VStack(alignment: .leading, spacing: 2) {
                Text(p.name).font(.callout).fontWeight(.medium)
                Text("\(p.models.count) model\(p.models.count == 1 ? "" : "s")")
                  .font(.caption2).foregroundStyle(.secondary)
              }
              Spacer()
            }
          }
        }
      }
      .listStyle(.sidebar)
      .frame(minWidth: 160)
      .safeAreaInset(edge: .bottom) {
        HStack(spacing: 4) {
          TextField("Add provider", text: $newProviderName)
            .textFieldStyle(.roundedBorder)
            .disableAutocorrection(true)
            .onSubmit {
              guard !newProviderName.isEmpty else { return }
              store.addProvider(newProviderName)
              selected = newProviderName
              newProviderName = ""
            }
          Button {
            store.addProvider(newProviderName)
            selected = newProviderName
            newProviderName = ""
          } label: {
            Image(systemName: "plus")
          }.disabled(newProviderName.isEmpty)
        }
        .padding(8)
      }
    } detail: {
      if let sel = selected, let p = store.providers.first(where: { $0.name == sel }) {
        ProviderDetail(store: store, provider: p)
      } else {
        ContentUnavailableView(
          "Select a provider", systemImage: "server.rack",
          description: Text("Choose a provider from the sidebar or add a new one."))
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
      Section("Connection") {
        LabeledContent("Base URL") {
          TextField("https://api.example.com/v1", text: $baseUrl)
            .disableAutocorrection(true)
        }
        LabeledContent("API type") {
          Picker("", selection: $api) {
            Text("OpenAI Completions").tag("openai-completions")
            Text("Anthropic").tag("anthropic")
            Text("Custom").tag("")
          }.labelsHidden()
        }
        LabeledContent("API key") {
          SecureField("$ENV_VAR or literal", text: $apiKey)
        }
        Text("Use $ENV_VAR syntax to read the key from the environment.")
          .font(.caption).foregroundStyle(.tertiary)
      }
      Section {
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
          ContentUnavailableView(
            "No models", systemImage: "cpu",
            description: Text("Models are synced from the provider's catalog.")
          )
          .frame(maxWidth: .infinity).padding(.vertical, 12)
        } else {
          ForEach(provider.models) { m in
            HStack {
              VStack(alignment: .leading, spacing: 2) {
                Text(m.name).font(.callout)
                Text(m.modelId).font(.caption2).foregroundStyle(.secondary)
              }
              Spacer()
              Text("ctx \(Fmt.tokens(m.contextWindow))")
                .font(.caption2).foregroundStyle(.tertiary)
            }
          }
        }
      }
    }
    .formStyle(.grouped)
    .navigationTitle(provider.name)
    .onAppear {
      baseUrl = provider.baseUrl
      api = provider.api
      apiKey = provider.apiKey
    }
    .onChange(of: provider.name) { _, _ in
      baseUrl = provider.baseUrl
      api = provider.api
      apiKey = provider.apiKey
    }
  }
}

// MARK: - Shortcut cheat sheet

struct ShortcutsTab: View {
  private let groups: [(String, [(String, String)])] = [
    (
      "Tabs",
      [
        ("⌘1–9", "Jump to tab N (⌘9 = last)"),
        ("⌃Tab", "Next tab"),
        ("⌃⇧Tab", "Previous tab"),
        ("⌘W", "Close current tab"),
      ]
    ),
    (
      "Sessions",
      [
        ("⌘O", "Open folder"),
        ("⇧⌘R", "Refresh sessions"),
        ("⌘,", "Open settings"),
      ]
    ),
    (
      "Composer",
      [
        ("Return", "Send message"),
        ("⇧Return", "New line"),
        ("/", "Open slash command menu"),
        ("!cmd", "Run a bash command in the session"),
        ("!!cmd", "Run bash, exclude from LLM context"),
      ]
    ),
    (
      "While streaming",
      [
        ("Return", "Steer (interrupt with new message)"),
        ("Stop button", "Abort the current turn"),
      ]
    ),
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
