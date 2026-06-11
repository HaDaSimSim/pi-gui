import PiCore
import SwiftUI

// Right-side info panel: Info / Subagents / Tasks / Git tabs.
// Styled like Xcode's inspector — compact, system-styled Form sections.
struct InfoPanelView: View {
  var runtime: RuntimeSession
  @State private var selection = 0

  var body: some View {
    VStack(spacing: 0) {
      // Segmented picker (Liquid Glass on macOS 26+)
      Picker("", selection: $selection.animation(.easeInOut(duration: 0.18))) {
        Text("Info").tag(0)
        Text("Subagents").tag(1)
        Text("Tasks").tag(2)
        Text("Git").tag(3)
      }
      .pickerStyle(.segmented)
      .labelsHidden()
      .padding(8)
      .modifier(InspectorPickerBackground())

      Divider()

      // Tab content
      Group {
        switch selection {
        case 0: infoTab
        case 1: subagentsTab
        case 2: tasksTab
        default: GitPanelView(cwd: runtime.cwd)
        }
      }
      .id(selection)
      .transition(.opacity)
    }
    .background(.background)
  }

  // MARK: - Info tab

  private var infoTab: some View {
    Form {
      Section("Session") {
        InlineRename(runtime: runtime)
      }

      Section("Model") {
        ModelEffortControls(runtime: runtime)
      }

      if runtime.footer.contextWindow > 0 {
        Section("Context") {
          let pct = Int(
            Double(runtime.footer.contextTokens) / Double(runtime.footer.contextWindow) * 100)
          LabeledContent("Usage") {
            Text(
              "\(Fmt.tokens(runtime.footer.contextTokens))/\(Fmt.tokens(runtime.footer.contextWindow)) (\(pct)%)"
            )
          }
          ProgressView(
            value: Double(runtime.footer.contextTokens),
            total: Double(runtime.footer.contextWindow))
        }
      }

      Section("Tokens") {
        TokenCompositionBar(footer: runtime.footer)
        LabeledContent("Input", value: Fmt.tokens(runtime.footer.inputTokens))
        LabeledContent("Output", value: Fmt.tokens(runtime.footer.outputTokens))
        LabeledContent("Cache read", value: Fmt.tokens(runtime.footer.cacheRead))
        LabeledContent("Cache write", value: Fmt.tokens(runtime.footer.cacheWrite))
        LabeledContent("Total", value: Fmt.tokens(runtime.footer.totalTokens))
        LabeledContent("Cost", value: Fmt.cost(runtime.footer.cost))
      }

      Section("Capabilities") {
        CapabilitiesSection(commands: runtime.commands)
      }
    }
    .formStyle(.grouped)
  }

  // MARK: - Subagents tab

  private var subagentsTab: some View {
    let runs = runtime.items.compactMap { item -> SubagentRun? in
      if case .subagentRun(_, let r) = item { return r }
      return nil
    }
    return Group {
      if runs.isEmpty {
        ContentUnavailableView("No subagents", systemImage: "person.2")
      } else {
        SubagentsList(runs: runs)
      }
    }
  }

  // MARK: - Tasks tab

  private var tasksTab: some View {
    let todos = runtime.items.reversed().compactMap { item -> [TodoItem]? in
      if case .todoList(_, let t) = item { return t }
      return nil
    }.first
    let goal = runtime.items.reversed().compactMap { item -> (String, String)? in
      if case .goalState(_, let obj, let status) = item { return (obj, status) }
      return nil
    }.first
    return Form {
      if let goal {
        Section("Goal") {
          LabeledContent(goal.0) {
            Text("\(Theme.goalEmoji(goal.1)) \(goal.1)")
          }
        }
      }
      if let todos, !todos.isEmpty {
        Section("Todos") {
          TodoWidget(todos: todos, isStreaming: runtime.isStreaming)
        }
      }
      if goal == nil && (todos?.isEmpty ?? true) {
        ContentUnavailableView("No goal or todos yet", systemImage: "checklist")
      }
    }
    .formStyle(.grouped)
  }
}

// MARK: - Picker background (Liquid Glass on macOS 26+)

private struct InspectorPickerBackground: ViewModifier {
  func body(content: Content) -> some View {
    if #available(macOS 26, *) {
      content.glassEffect(.regular)
    } else {
      content.background(.bar)
    }
  }
}

// MARK: - Info tab components

private struct InlineRename: View {
  var runtime: RuntimeSession
  @State private var editing = false
  @State private var draft = ""

  var body: some View {
    if editing {
      HStack(spacing: 6) {
        TextField("Name", text: $draft)
          .textFieldStyle(.roundedBorder)
          .autocorrectionDisabled()
          .onSubmit { commit() }
        Button("Save") { commit() }.controlSize(.small)
        Button("Cancel") { editing = false }.controlSize(.small)
      }
    } else {
      LabeledContent("Name") {
        HStack(spacing: 4) {
          Text(runtime.sessionName ?? "Untitled")
            .lineLimit(1)
          Button {
            draft = runtime.sessionName ?? ""
            editing = true
          } label: {
            Image(systemName: "pencil").font(.caption2)
          }
          .buttonStyle(.borderless)
        }
      }
    }
  }

  private func commit() {
    if !draft.isEmpty { runtime.rename(draft) }
    editing = false
  }
}

private struct ModelEffortControls: View {
  var runtime: RuntimeSession
  @Environment(AppModel.self) var model

  var body: some View {
    HStack(spacing: 8) {
      ModelPicker(runtime: runtime)
      EffortPicker(runtime: runtime)
      Spacer()
    }
  }
}

private struct TokenCompositionBar: View {
  let footer: FooterStats

  var body: some View {
    let total = max(
      footer.inputTokens + footer.outputTokens + footer.cacheRead + footer.cacheWrite, 1)
    VStack(alignment: .leading, spacing: 4) {
      GeometryReader { geo in
        HStack(spacing: 0) {
          segment(geo.size.width, footer.inputTokens, total, Theme.tokInput)
          segment(geo.size.width, footer.outputTokens, total, Theme.tokOutput)
          segment(geo.size.width, footer.cacheRead, total, Theme.tokCacheRead)
          segment(geo.size.width, footer.cacheWrite, total, Theme.tokCacheWrite)
        }
      }
      .frame(height: 6)
      .clipShape(Capsule())

      // Legend
      HStack(spacing: 10) {
        legendDot("In", Theme.tokInput)
        legendDot("Out", Theme.tokOutput)
        legendDot("Cache R", Theme.tokCacheRead)
        legendDot("Cache W", Theme.tokCacheWrite)
      }
      .font(.caption2)
      .foregroundStyle(.secondary)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(
      "Token composition: input \(Fmt.tokens(footer.inputTokens)), output \(Fmt.tokens(footer.outputTokens)), cache read \(Fmt.tokens(footer.cacheRead)), cache write \(Fmt.tokens(footer.cacheWrite))"
    )
  }

  private func segment(_ width: CGFloat, _ value: Int, _ total: Int, _ color: Color) -> some View {
    color.frame(width: width * CGFloat(value) / CGFloat(total))
  }

  private func legendDot(_ label: String, _ color: Color) -> some View {
    HStack(spacing: 3) {
      Circle().fill(color).frame(width: 6, height: 6)
      Text(label)
    }
  }
}

private struct CapabilitiesSection: View {
  let commands: [SlashCommand]

  var body: some View {
    let groups: [(String, [SlashCommand])] = [
      ("Extensions", commands.filter { $0.source == "extension" }),
      ("Skills", commands.filter { $0.source == "skill" }),
      ("Prompts", commands.filter { $0.source == "prompt" }),
    ].filter { !$0.1.isEmpty }

    if groups.isEmpty {
      Text("Send a message to load commands")
        .font(.caption2)
        .foregroundStyle(.tertiary)
    } else {
      ForEach(groups, id: \.0) { group in
        DisclosureGroup(group.0) {
          ForEach(group.1) { cmd in
            VStack(alignment: .leading, spacing: 1) {
              HStack(spacing: 4) {
                Text("/\(cmd.name.replacingOccurrences(of: "skill:", with: ""))")
                  .font(.system(.caption2, design: .monospaced))
                  .fontWeight(.medium)
                if let hint = cmd.argumentHint {
                  Text(hint).font(.caption2).foregroundStyle(.tertiary)
                }
              }
              if let d = cmd.description {
                Text(d).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
              }
            }
          }
        }
      }
    }
  }
}
