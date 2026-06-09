import SwiftUI

// Model / thinking / rename controls. Mirrors web/model-controls.tsx + info-panel.
struct ControlsSheet: View {
    @ObservedObject var vm: SessionViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var models: [ModelInfo] = []
    @State private var renaming = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Session") {
                    HStack {
                        TextField("Name", text: $renaming)
                        Button("Rename") { Task { await vm.rename(renaming) } }
                            .disabled(renaming.isEmpty)
                    }
                    LabeledContent("Live", value: vm.live ? "yes" : "no")
                }

                Section("Model") {
                    if models.isEmpty {
                        ProgressView()
                    } else {
                        ForEach(models, id: \.self) { m in
                            Button {
                                Task { await vm.setModel(provider: m.provider, id: m.id) }
                            } label: {
                                HStack {
                                    VStack(alignment: .leading) {
                                        Text(m.name)
                                        Text("\(m.provider)/\(m.id)").font(.caption2).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    if vm.controls?.model?.id == m.id { Image(systemName: "checkmark").foregroundStyle(.tint) }
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }

                if let controls = vm.controls, controls.supportsThinking {
                    Section("Thinking") {
                        ForEach(controls.availableThinkingLevels, id: \.self) { level in
                            Button {
                                Task { await vm.setThinking(level) }
                            } label: {
                                HStack {
                                    Text(level.capitalized)
                                    Spacer()
                                    if controls.thinkingLevel == level { Image(systemName: "checkmark").foregroundStyle(.tint) }
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .navigationTitle("Controls")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task {
                renaming = vm.name ?? ""
                models = (try? await vm.apiRef.models()) ?? []
            }
        }
    }
}

// Slash command picker. Mirrors web command palette.
struct CommandsSheet: View {
    @ObservedObject var vm: SessionViewModel
    var onPick: (SlashCommand) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var commands: [SlashCommand] = []
    @State private var filter = ""

    private var filtered: [SlashCommand] {
        filter.isEmpty ? commands : commands.filter { $0.name.localizedCaseInsensitiveContains(filter) }
    }

    var body: some View {
        NavigationStack {
            List(filtered) { cmd in
                Button { onPick(cmd) } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        HStack {
                            Text("/\(cmd.name)").font(.body.monospaced().weight(.medium))
                            if let hint = cmd.argumentHint { Text(hint).font(.caption2).foregroundStyle(.secondary) }
                        }
                        if let d = cmd.description { Text(d).font(.caption).foregroundStyle(.secondary) }
                    }
                }
            }
            .searchable(text: $filter)
            .navigationTitle("Commands")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .overlay { if commands.isEmpty { ContentUnavailableView("No commands", systemImage: "command", description: Text("Commands appear once the session has a live runtime.")) } }
            .task { commands = (try? await vm.apiRef.commands(path: vm.path)) ?? [] }
        }
    }
}
