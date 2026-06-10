import SwiftUI

// Right-side info panel: Info / Subagents / Tasks / Git tabs.
struct InfoPanelView: View {
  @ObservedObject var runtime: RuntimeSession
  @State private var selection = 0

  var body: some View {
    VStack(spacing: 0) {
      Picker("", selection: $selection.animation(.easeInOut(duration: 0.18))) {
        Text("Info").tag(0)
        Text("Subagents").tag(1)
        Text("Tasks").tag(2)
        Text("Git").tag(3)
      }
      .pickerStyle(.segmented)
      .labelsHidden()
      .padding(8)
      Divider()
      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          switch selection {
          case 0: infoTab
          case 1: subagentsTab
          case 2: tasksTab
          default: GitPanelView(cwd: runtime.cwd)
          }
        }
        .id(selection)
        .transition(.opacity)
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .background(.background)
  }

  private var infoTab: some View {
    VStack(alignment: .leading, spacing: 14) {
      // Inline rename.
      InlineRename(runtime: runtime)
      // Model + effort controls (shared with the composer).
      ModelEffortControls(runtime: runtime)
      Divider()
      // Context window.
      if runtime.footer.contextWindow > 0 {
        let pct = Int(
          Double(runtime.footer.contextTokens) / Double(runtime.footer.contextWindow) * 100)
        VStack(alignment: .leading, spacing: 4) {
          Text("Context").font(.caption).foregroundStyle(.secondary)
          ProgressView(
            value: Double(runtime.footer.contextTokens),
            total: Double(runtime.footer.contextWindow))
          Text(
            "\(Fmt.tokens(runtime.footer.contextTokens))/\(Fmt.tokens(runtime.footer.contextWindow)) (\(pct)%)"
          )
          .font(.caption2).foregroundStyle(.secondary)
        }
      }
      // Token composition bar.
      TokenCompositionBar(footer: runtime.footer)
      // Stats grid.
      statsGrid
      Divider()
      // Capabilities (extensions / skills / prompts).
      CapabilitiesSection(commands: runtime.commands)
    }
  }

  private var statsGrid: some View {
    let f = runtime.footer
    return LazyVGrid(
      columns: [
        GridItem(.flexible(), alignment: .leading),
        GridItem(.flexible(), alignment: .leading),
      ], spacing: 6
    ) {
      statCell("Cost", Fmt.cost(f.cost))
      statCell("Tokens", Fmt.tokens(f.totalTokens))
      statCell("Input", Fmt.tokens(f.inputTokens))
      statCell("Output", Fmt.tokens(f.outputTokens))
      statCell("Cache read", Fmt.tokens(f.cacheRead))
      statCell("Cache write", Fmt.tokens(f.cacheWrite))
    }
  }

  private func statCell(_ label: String, _ value: String) -> some View {
    VStack(alignment: .leading, spacing: 1) {
      Text(label).font(.caption2).foregroundStyle(.secondary)
      Text(value).font(.caption).fontWeight(.medium)
    }
  }

  private var subagentsTab: some View {
    let runs = runtime.items.compactMap { item -> SubagentRun? in
      if case .subagentRun(_, let r) = item { return r }
      return nil
    }
    return SubagentsList(runs: runs)
  }

  private var tasksTab: some View {
    let todos = runtime.items.reversed().compactMap { item -> [TodoItem]? in
      if case .todoList(_, let t) = item { return t }
      return nil
    }.first
    let goal = runtime.items.reversed().compactMap { item -> (String, String)? in
      if case .goalState(_, let obj, let status) = item { return (obj, status) }
      return nil
    }.first
    return VStack(alignment: .leading, spacing: 12) {
      if let goal {
        HStack(spacing: 7) {
          Text(Theme.goalEmoji(goal.1))
          VStack(alignment: .leading, spacing: 1) {
            Text(goal.0).font(.callout).fontWeight(.medium)
            Text("goal \(goal.1)").font(.caption2).foregroundStyle(.secondary)
          }
          Spacer()
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 8))
      }
      if let todos, !todos.isEmpty {
        TodoWidget(todos: todos, isStreaming: runtime.isStreaming)
      }
      if goal == nil && (todos?.isEmpty ?? true) {
        ContentUnavailableView("No goal or todos yet", systemImage: "checklist")
      }
    }
  }

  private func row(_ label: String, _ value: String) -> some View {
    HStack {
      Text(label).font(.caption).foregroundStyle(.secondary)
      Spacer()
      Text(value).font(.caption).fontWeight(.medium).textSelection(.enabled)
    }
  }
}

// MARK: - Info tab building blocks

private struct InlineRename: View {
  @ObservedObject var runtime: RuntimeSession
  @State private var editing = false
  @State private var draft = ""
  var body: some View {
    HStack(spacing: 6) {
      Text("Session").font(.caption).foregroundStyle(.secondary)
      if editing {
        TextField("name", text: $draft).textFieldStyle(.roundedBorder)
          .disableAutocorrection(true)
          .onSubmit { commit() }
        Button("Save") { commit() }.font(.caption)
        Button("Cancel") { editing = false }.font(.caption)
      } else {
        Text(runtime.sessionName ?? "—").font(.caption).fontWeight(.medium).lineLimit(1)
        Button {
          draft = runtime.sessionName ?? ""
          editing = true
        } label: {
          Image(systemName: "pencil").font(.caption2)
        }.buttonStyle(.borderless)
        Spacer()
      }
    }
  }
  private func commit() {
    if !draft.isEmpty { runtime.rename(draft) }
    editing = false
  }
}

private struct ModelEffortControls: View {
  @ObservedObject var runtime: RuntimeSession
  @EnvironmentObject var model: AppModel
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
    return VStack(alignment: .leading, spacing: 3) {
      Text("Token composition").font(.caption2).foregroundStyle(.secondary)
      GeometryReader { geo in
        HStack(spacing: 0) {
          seg(geo.size.width, footer.inputTokens, total, Theme.tokInput)
          seg(geo.size.width, footer.outputTokens, total, Theme.tokOutput)
          seg(geo.size.width, footer.cacheRead, total, Theme.tokCacheRead)
          seg(geo.size.width, footer.cacheWrite, total, Theme.tokCacheWrite)
        }
      }
      .frame(height: 6)
      .clipShape(Capsule())
    }
  }
  private func seg(_ width: CGFloat, _ value: Int, _ total: Int, _ color: Color) -> some View {
    color.frame(width: width * CGFloat(value) / CGFloat(total))
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
    return VStack(alignment: .leading, spacing: 6) {
      Text("Capabilities").font(.caption).foregroundStyle(.secondary)
      if groups.isEmpty {
        Text("Send a message to load commands").font(.caption2).foregroundStyle(.tertiary)
      }
      ForEach(groups, id: \.0) { group in
        CapabilityGroup(title: group.0, commands: group.1)
      }
    }
  }
}

private struct CapabilityGroup: View {
  let title: String
  let commands: [SlashCommand]
  @State private var expanded = false
  var body: some View {
    DisclosureGroup(isExpanded: $expanded) {
      ForEach(commands) { c in
        VStack(alignment: .leading, spacing: 0) {
          HStack(spacing: 4) {
            Text("/\(c.name.replacingOccurrences(of: "skill:", with: ""))")
              .font(.system(.caption2, design: .monospaced)).fontWeight(.medium)
            if let hint = c.argumentHint {
              Text(hint).font(.caption2).foregroundStyle(.tertiary)
            }
          }
          if let d = c.description {
            Text(d).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
    } label: {
      Text("\(title) · \(commands.count)").font(.caption2).foregroundStyle(.secondary)
    }
  }
}
