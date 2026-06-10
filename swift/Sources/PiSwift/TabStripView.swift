import SwiftUI

// Flat document tabs (Finder/Safari/Xcode idiom), not segmented pills: fixed-min-width tabs in a
// horizontally scrollable row, the selected tab marked by an accent underline (the web app's
// house style: border-b-2 border-primary) plus a subtle fill, inactive tabs flat with a hover
// fill, 1pt dividers between tabs, semantic colors only (dark-mode safe). Close (\u00d7) sits in a
// real trailing slot so it never overlaps the title hit area.
struct TabStripView: View {
  @EnvironmentObject var model: AppModel

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 0) {
        ForEach(Array(model.tabs.enumerated()), id: \.element.id) { index, tab in
          if index > 0 {
            Divider().frame(height: 16).opacity(0.5)
          }
          TabItem(
            tab: tab,
            index: index,
            isActive: tab.id == model.activeTabID,
            onSelect: { model.activeTabID = tab.id },
            onClose: { model.closeTab(tab.id) })
        }
      }
    }
    .frame(height: 30)
    .background(.bar)
    .overlay(alignment: .bottom) { Divider() }
    .animation(.easeInOut(duration: 0.18), value: model.tabs.count)
    .animation(.easeInOut(duration: 0.12), value: model.activeTabID)
  }
}

private struct TabItem: View {
  let tab: AppModel.Tab
  let index: Int
  let isActive: Bool
  let onSelect: () -> Void
  let onClose: () -> Void
  @ObservedObject var runtime: RuntimeSession
  @State private var hovering = false
  @State private var confirmClose = false

  init(
    tab: AppModel.Tab, index: Int, isActive: Bool,
    onSelect: @escaping () -> Void, onClose: @escaping () -> Void
  ) {
    self.tab = tab
    self.index = index
    self.isActive = isActive
    self.onSelect = onSelect
    self.onClose = onClose
    self.runtime = tab.runtime
  }

  private var title: String { runtime.sessionName ?? tab.title }

  var body: some View {
    HStack(spacing: 6) {
      // Leading status: streaming spinner, else a live dot for held sessions.
      if runtime.isStreaming {
        ProgressView().controlSize(.small).scaleEffect(0.5)
          .frame(width: 12, height: 12)
          .accessibilityLabel("Working")
      }
      Text(title)
        .font(.system(size: 12))
        .fontWeight(isActive ? .medium : .regular)
        .foregroundStyle(isActive ? .primary : .secondary)
        .lineLimit(1)
        .truncationMode(.tail)
      Spacer(minLength: 0)
      // Close button in a real trailing slot (never overlaps the title).
      Button(action: { if runtime.isStreaming { confirmClose = true } else { onClose() } }) {
        Image(systemName: "xmark")
          .font(.system(size: 9, weight: .semibold))
          .frame(width: 18, height: 18)
          .background(hovering ? Color.secondary.opacity(0.22) : .clear, in: Circle())
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .foregroundStyle(.secondary)
      .opacity(hovering || isActive ? 1 : 0)
      .help("Close tab")
      .confirmationDialog(
        "This session is still running. Stop it and close the tab?",
        isPresented: $confirmClose
      ) {
        Button("Stop and close", role: .destructive) {
          runtime.abort()
          onClose()
        }
        Button("Cancel", role: .cancel) {}
      }
    }
    .padding(.leading, 12)
    .padding(.trailing, 6)
    .frame(width: 190, height: 30)
    .background(tabBackground)
    .overlay(alignment: .bottom) {
      // Accent underline marks the selected tab (web house style).
      Rectangle()
        .fill(Color.accentColor)
        .frame(height: 2)
        .opacity(isActive ? 1 : 0)
    }
    .contentShape(Rectangle())
    .onTapGesture(perform: onSelect)
    .onHover { hovering = $0 }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(title)
    .accessibilityAddTraits(isActive ? [.isButton, .isSelected] : .isButton)
    .accessibilityHint("Switch to this session. \u{2318}\(index + 1).")
  }

  private var tabBackground: some ShapeStyle {
    if isActive { return AnyShapeStyle(Color.secondary.opacity(0.10)) }
    if hovering { return AnyShapeStyle(Color.secondary.opacity(0.06)) }
    return AnyShapeStyle(Color.clear)
  }
}
