import SwiftUI
import AppKit
import UniformTypeIdentifiers

// Composer: model/thinking controls, slash menu, IME-safe input, send/steer/stop.
struct ComposerView: View {
    @ObservedObject var runtime: RuntimeSession
    @EnvironmentObject var model: AppModel
    @Binding var draft: String
    @State private var showSlashMenu = false
    @State private var deliverAs: String = "steer"   // when streaming: steer | followUp
    @State private var attachments: [AttachedImage] = []
    @State private var inputHeight: CGFloat = 34

    var body: some View {
        VStack(spacing: 6) {
            // Todo widget (above editor) when todos exist.
            if let todo = latestTodo, !todo.isEmpty {
                TodoWidget(todos: todo, isStreaming: runtime.isStreaming)
            }

            if showSlashMenu && !slashMatches.isEmpty {
                slashMenu
            }

            if !attachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(attachments) { att in
                            HStack(spacing: 4) {
                                Image(systemName: "photo").font(.caption2)
                                Text(att.name).font(.caption2).lineLimit(1)
                                Button { attachments.removeAll { $0.id == att.id } } label: {
                                    Image(systemName: "xmark.circle.fill").font(.caption2)
                                }.buttonStyle(.borderless)
                            }
                            .padding(.horizontal, 6).padding(.vertical, 3)
                            .background(.quaternary, in: Capsule())
                        }
                    }
                }
            }

            HStack(alignment: .top, spacing: 8) {
                modelControls
                Spacer()
            }

            HStack(alignment: .bottom, spacing: 8) {
                Button { pickImages() } label: { Image(systemName: "paperclip") }
                    .buttonStyle(.borderless).help("Attach image")
                ComposerTextView(text: $draft, measuredHeight: $inputHeight, onSubmit: submit)
                    .frame(height: inputHeight)
                    .padding(.horizontal, 6)
                    .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(.quaternary, lineWidth: 1))
                    .onChange(of: draft) { _, v in
                        showSlashMenu = v.hasPrefix("/") && !v.contains(" ")
                    }

                if runtime.isStreaming {
                    Button(role: .destructive) { runtime.abort() } label: {
                        Image(systemName: "stop.fill")
                    }
                    .help("Stop")
                    sendButton(label: deliverAs == "steer" ? "Steer" : "Follow-up", icon: "arrow.up")
                } else {
                    sendButton(label: "Send", icon: "arrow.up")
                }
            }
        }
        .padding(12)
    }

    private var modelControls: some View {
        HStack(spacing: 8) {
            Menu {
                ForEach(model.models) { m in
                    Button(m.spec) {
                        runtime.setModel(provider: m.provider, modelId: m.id)
                    }
                }
            } label: {
                Label(runtime.model ?? model.config.defaultModelSpec ?? "model",
                      systemImage: "cpu")
                    .font(.caption)
            }
            .menuStyle(.borderlessButton).fixedSize()

            Menu {
                ForEach(["off", "minimal", "low", "medium", "high", "xhigh"], id: \.self) { lvl in
                    Button(lvl) { runtime.setThinking(lvl) }
                }
            } label: {
                Text(runtime.thinkingLevel).font(.caption)
            }
            .menuStyle(.borderlessButton).fixedSize()
        }
    }

    private func sendButton(label: String, icon: String) -> some View {
        Button(action: submit) {
            Image(systemName: icon)
                .fontWeight(.bold)
        }
        .keyboardShortcut(.return, modifiers: [])
        .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        .help(label)
    }

    private var slashMenu: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(slashMatches.prefix(8)) { cmd in
                Button {
                    draft = "/\(cmd.name) "
                    showSlashMenu = false
                } label: {
                    HStack {
                        Text("/\(cmd.name)").font(.system(.callout, design: .monospaced))
                        if let d = cmd.description {
                            Text(d).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer()
                        if cmd.source != "extension" {
                            Text(cmd.source).font(.caption2).foregroundStyle(.tertiary)
                        }
                    }
                    .contentShape(Rectangle())
                    .padding(.horizontal, 8).padding(.vertical, 4)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(4)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
    }

    private var slashMatches: [SlashCommand] {
        let q = draft.dropFirst().lowercased()
        return runtime.commands.filter { q.isEmpty || $0.name.lowercased().hasPrefix(q) }
    }

    private var latestTodo: [TodoItem]? {
        for item in runtime.items.reversed() {
            if case .todoList(_, let todos) = item { return todos }
        }
        return nil
    }

    private func submit() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || !attachments.isEmpty else { return }
        if let tab = model.activeTab, tab.id == model.activeTabID {
            model.ensureRuntimeStarted(for: tab)
        }
        // !cmd / !!cmd run a bash command in the session (!! keeps output out of LLM context).
        if text.hasPrefix("!!") {
            let cmd = String(text.dropFirst(2)).trimmingCharacters(in: .whitespaces)
            if !cmd.isEmpty { runtime.runBash(cmd, excludeFromContext: true) }
        } else if text.hasPrefix("!") {
            let cmd = String(text.dropFirst(1)).trimmingCharacters(in: .whitespaces)
            if !cmd.isEmpty { runtime.runBash(cmd, excludeFromContext: false) }
        } else {
            runtime.sendPrompt(text, images: attachments.map { $0.rpcDict })
        }
        draft = ""
        attachments = []
        showSlashMenu = false
    }

    /// Native image picker. Read each file, base64-encode, and stage as an attachment.
    private func pickImages() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = true
        panel.allowedContentTypes = [.png, .jpeg, .gif, .webP, .image]
        if panel.runModal() == .OK {
            for url in panel.urls { if let a = AttachedImage(url: url) { attachments.append(a) } }
        }
    }
}

/// A staged image attachment, encoded for the RPC prompt `images` field.
struct AttachedImage: Identifiable {
    let id = UUID()
    let name: String
    let mimeType: String
    let base64: String

    init?(url: URL) {
        guard let data = try? Data(contentsOf: url) else { return nil }
        self.name = url.lastPathComponent
        self.base64 = data.base64EncodedString()
        switch url.pathExtension.lowercased() {
        case "png": mimeType = "image/png"
        case "jpg", "jpeg": mimeType = "image/jpeg"
        case "gif": mimeType = "image/gif"
        case "webp": mimeType = "image/webp"
        default: mimeType = "image/png"
        }
    }
    var rpcDict: [String: Any] { ["type": "image", "data": base64, "mimeType": mimeType] }
}

struct TodoWidget: View {
    let todos: [TodoItem]
    let isStreaming: Bool
    @State private var expanded = true
    private var done: Int { todos.filter { $0.status == "completed" }.count }
    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(sorted.prefix(8)) { t in
                    HStack(spacing: 6) {
                        todoIcon(t)
                        Text(t.status == "in_progress" ? (t.activeForm ?? t.content) : t.content)
                            .font(.caption)
                            .strikethrough(t.status == "completed")
                            .foregroundStyle(t.status == "pending" ? .secondary : .primary)
                            .lineLimit(1)
                        Spacer()
                    }
                }
                if todos.count > 8 { Text("…and \(todos.count - 8) more").font(.caption2).foregroundStyle(.tertiary) }
            }
            .padding(.top, 4)
        } label: {
            HStack(spacing: 8) {
                ProgressView(value: Double(done), total: Double(max(todos.count, 1)))
                    .frame(width: 120)
                Text("\(done)/\(todos.count) todos").font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(8)
        .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 8))
    }
    private var sorted: [TodoItem] {
        let order = ["in_progress": 0, "pending": 1, "completed": 2]
        return todos.sorted { (order[$0.status] ?? 1) < (order[$1.status] ?? 1) }
    }
    @ViewBuilder private func todoIcon(_ t: TodoItem) -> some View {
        switch t.status {
        case "completed": Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.success).font(.caption)
        case "in_progress":
            if isStreaming { ProgressView().controlSize(.small) }
            else { Image(systemName: "smallcircle.filled.circle").foregroundStyle(Theme.info).font(.caption) }
        default: Image(systemName: "circle").foregroundStyle(.tertiary).font(.caption)
        }
    }
}
