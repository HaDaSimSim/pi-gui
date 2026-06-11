import AppKit
import PiCore
import SwiftUI
import UniformTypeIdentifiers

// Composer: model/thinking controls, slash menu, IME-safe input, send/steer/stop.
struct ComposerView: View {
  var runtime: RuntimeSession
  @Environment(AppModel.self) var model
  @Binding var draft: String
  var appModel: AppModel?
  @State private var showSlashMenu = false
  @State private var deliverAs: String = "steer"  // when streaming: steer | followUp
  @State private var attachments: [AttachedImage] = []
  @State private var inputHeight: CGFloat = 22
  @State private var isComposerFocused: Bool = false

  /// Whether the composer can send (lock must be owned or not yet acquired for queued prompt).
  private var canSend: Bool {
    runtime.lockStatus == .owned
  }

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
                Button {
                  attachments.removeAll { $0.id == att.id }
                } label: {
                  Image(systemName: "xmark.circle.fill").font(.caption2)
                }.buttonStyle(.borderless)
              }
              .padding(.horizontal, 6).padding(.vertical, 3)
              .background(.quaternary, in: Capsule())
            }
          }
        }
      }

      // iMessage-style pill input
      HStack(alignment: .center, spacing: 8) {
        // Attach button (left)
        Button {
          pickImages()
        } label: {
          Image(systemName: "plus")
            .font(.system(size: 15, weight: .medium))
            .foregroundStyle(.secondary)
        }
        .buttonStyle(.plain)
        .help("Attach image")

        // Text input (fills available space)
        ComposerTextView(
          text: $draft,
          measuredHeight: $inputHeight,
          isFocused: isComposerFocused,
          onFocusChange: { isComposerFocused = $0 },
          onSubmit: submit,
          onEscape: { isComposerFocused = false }
        )
        .frame(height: inputHeight)
        .onChange(of: draft) { _, v in
          showSlashMenu = v.hasPrefix("/") && !v.contains(" ")
        }

        // Action buttons (right)
        if runtime.isStreaming {
          Picker("", selection: $deliverAs) {
            Text("Steer").tag("steer")
            Text("Follow-up").tag("followUp")
          }
          .pickerStyle(.segmented)
          .frame(width: 130)
          .help(deliverAs == "steer" ? "Interrupt and redirect" : "Queue after current response")

          composerCircle(icon: "stop.fill", tint: Theme.danger, enabled: canSend) {
            runtime.abort()
          }
          composerCircle(
            icon: "arrow.up", tint: .accentColor,
            enabled: canSend && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
          ) { submit() }
        } else {
          composerCircle(
            icon: "arrow.up", tint: .accentColor,
            enabled:
              canSend
              && !(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                && attachments.isEmpty)
          ) { submit() }
        }
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 6)
      .background(Color(nsColor: .textBackgroundColor))
      .clipShape(RoundedRectangle(cornerRadius: 20))
      .overlay(
        RoundedRectangle(cornerRadius: 20)
          .stroke(Color.secondary.opacity(0.2), lineWidth: 1)
      )

      // Model/thinking controls below the pill
      HStack(spacing: 8) {
        modelControls
        Spacer()
      }
      .padding(.horizontal, 4)
    }
    .padding(12)
    .onAppear { isComposerFocused = true }
    .focusedSceneValue(\.activeRuntime, runtime)
  }

  private var modelControls: some View {
    HStack(spacing: 8) {
      ModelPicker(runtime: runtime)
      EffortPicker(runtime: runtime)
    }
  }

  private func composerCircle(
    icon: String, tint: Color, enabled: Bool,
    action: @escaping () -> Void
  ) -> some View {
    Button(action: action) {
      Image(systemName: icon)
        .font(.system(size: 12, weight: .bold))
        .foregroundStyle(.white)
        .frame(width: 26, height: 26)
        .background(Circle().fill(enabled ? tint : Color.secondary.opacity(0.4)))
    }
    .buttonStyle(.plain)
    .disabled(!enabled)
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
    runtime.latestTodo
  }

  private func submit() {
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty || !attachments.isEmpty else { return }
    if let appModel { appModel.ensureRuntimeStarted(runtime) }
    // !cmd / !!cmd run a bash command in the session (!! keeps output out of LLM context).
    if text.hasPrefix("!!") {
      let cmd = String(text.dropFirst(2)).trimmingCharacters(in: .whitespaces)
      if !cmd.isEmpty { runtime.runBash(cmd, excludeFromContext: true) }
    } else if text.hasPrefix("!") {
      let cmd = String(text.dropFirst(1)).trimmingCharacters(in: .whitespaces)
      if !cmd.isEmpty { runtime.runBash(cmd, excludeFromContext: false) }
    } else {
      let behavior: String? = runtime.isStreaming ? deliverAs : nil
      runtime.sendPrompt(text, images: attachments.map { $0.rpcDict }, streamingBehavior: behavior)
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
        if todos.count > 8 {
          Text("…and \(todos.count - 8) more").font(.caption2).foregroundStyle(.tertiary)
        }
      }
      .padding(.top, 4)
    } label: {
      HStack(spacing: 8) {
        ProgressView(value: Double(done), total: Double(max(todos.count, 1)))
          .frame(width: 120)
        Text("\(done)/\(todos.count) todos").font(.caption).foregroundStyle(.secondary)
      }
      .accessibilityElement(children: .combine)
      .accessibilityLabel("Todo progress")
      .accessibilityValue("\(done) of \(todos.count) completed")
    }
    .padding(8)
    .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
  }
  private var sorted: [TodoItem] {
    let order = ["in_progress": 0, "pending": 1, "completed": 2]
    return todos.sorted { (order[$0.status] ?? 1) < (order[$1.status] ?? 1) }
  }
  @ViewBuilder private func todoIcon(_ t: TodoItem) -> some View {
    switch t.status {
    case "completed":
      Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.success).font(.caption)
    case "in_progress":
      if isStreaming {
        ProgressView().controlSize(.small)
      } else {
        Image(systemName: "smallcircle.filled.circle").foregroundStyle(Theme.info).font(.caption)
      }
    default: Image(systemName: "circle").foregroundStyle(.tertiary).font(.caption)
    }
  }
}
