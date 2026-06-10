import PiCore
import SwiftUI

// Searchable model combobox: a button showing the current model that opens a popover with a
// search field and a filtered list. Used by both the composer and the info panel so model
// selection is consistent and actually searchable (the previous flat Menu was unusable with
// many models).
struct ModelPicker: View {
  @ObservedObject var runtime: RuntimeSession
  @EnvironmentObject var model: AppModel
  @State private var showPopover = false
  @State private var query = ""

  // Current model falls back to the app default so browse-only tabs (no runtime yet) still show
  // a sensible value instead of "model".
  private var currentSpec: String {
    runtime.model.map { spec in
      // runtime.model is just the id; pair it with a provider if we can find it.
      model.models.first(where: { $0.id == spec })?.spec ?? spec
    } ?? model.config.defaultModelSpec ?? "Select model"
  }

  private var filtered: [ModelOption] {
    guard !query.isEmpty else { return model.models }
    return model.models.filter {
      $0.spec.localizedCaseInsensitiveContains(query)
        || $0.name.localizedCaseInsensitiveContains(query)
    }
  }

  var body: some View {
    Button {
      showPopover = true
    } label: {
      HStack(spacing: 4) {
        Image(systemName: "cpu").font(.caption2)
        Text(currentSpec).font(.caption).lineLimit(1)
        Image(systemName: "chevron.up.chevron.down").font(.system(size: 8)).foregroundStyle(
          .secondary)
      }
      .padding(.horizontal, 8).padding(.vertical, 4)
      .background(Color.secondary.opacity(0.1), in: Capsule())
      .contentShape(Capsule())
    }
    .buttonStyle(.plain)
    .popover(isPresented: $showPopover, arrowEdge: .bottom) {
      VStack(spacing: 0) {
        TextField("Search models", text: $query)
          .textFieldStyle(.roundedBorder)
          .disableAutocorrection(true)
          .padding(8)
        Divider()
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 0) {
            ForEach(filtered) { m in
              Button {
                runtime.setModel(provider: m.provider, modelId: m.id)
                showPopover = false
                query = ""
              } label: {
                HStack(spacing: 6) {
                  Text(m.spec).font(.system(.caption, design: .monospaced))
                  Spacer()
                  if runtime.model == m.id {
                    Image(systemName: "checkmark").font(.caption2).foregroundStyle(.tint)
                  }
                }
                .padding(.horizontal, 10).padding(.vertical, 5)
                .contentShape(Rectangle())
              }
              .buttonStyle(.plain)
            }
            if filtered.isEmpty {
              Text("No matching models").font(.caption).foregroundStyle(.secondary).padding(10)
            }
          }
        }
        .frame(maxHeight: 280)
      }
      .frame(width: 320)
    }
  }
}

// Effort/thinking picker as a fixed-width menu so it doesn't jump size between levels.
struct EffortPicker: View {
  @ObservedObject var runtime: RuntimeSession
  private let levels = ["off", "minimal", "low", "medium", "high", "xhigh"]
  var body: some View {
    Menu {
      ForEach(levels, id: \.self) { lvl in
        Button {
          runtime.setThinking(lvl)
        } label: {
          HStack {
            Text(lvl)
            if runtime.thinkingLevel == lvl { Image(systemName: "checkmark") }
          }
        }
      }
    } label: {
      HStack(spacing: 4) {
        Image(systemName: "brain").font(.caption2)
        Text(runtime.thinkingLevel).font(.caption)
      }
      .frame(width: 78, alignment: .leading)
      .padding(.horizontal, 8).padding(.vertical, 4)
      .background(Color.secondary.opacity(0.1), in: Capsule())
    }
    .menuStyle(.borderlessButton)
    .fixedSize()
  }
}
