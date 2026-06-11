import PiCore
import SwiftUI

// Horizontal tab strip showing open sessions — VS Code / Safari-style tabs above the detail area.
// Clicking a tab sets activeSessionId. Close button removes the tab via closeSession(id:).

struct SessionTabBar: View {
  @Environment(AppModel.self) var model

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 0) {
        ForEach(model.openSessions, id: \.id) { rt in
          tabItem(rt)
        }
      }
    }
    .frame(height: 28)
    .background(.bar)
  }

  private func tabItem(_ rt: RuntimeSession) -> some View {
    let isActive = rt.id == model.activeSessionId
    return Button {
      model.activeSessionId = rt.id
    } label: {
      HStack(spacing: 5) {
        Text(tabTitle(rt))
          .font(.system(size: 11.5, weight: isActive ? .medium : .regular))
          .lineLimit(1)
          .foregroundStyle(isActive ? .primary : .secondary)

        Button {
          model.closeSession(id: rt.id)
        } label: {
          Image(systemName: "xmark")
            .font(.system(size: 8, weight: .semibold))
            .foregroundStyle(.tertiary)
            .frame(width: 14, height: 14)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .opacity(isActive ? 1 : 0.5)
        .help("Close tab")
      }
      .padding(.horizontal, 10)
      .frame(height: 28)
      .background(isActive ? Color.accentColor.opacity(0.10) : Color.clear)
      .overlay(alignment: .bottom) {
        if isActive {
          Color.accentColor
            .frame(height: 2)
        }
      }
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Tab: \(tabTitle(rt))")
    .accessibilityAddTraits(isActive ? .isSelected : [])
  }

  private func tabTitle(_ rt: RuntimeSession) -> String {
    if let name = rt.sessionName, !name.isEmpty { return name }
    return (rt.cwd as NSString).lastPathComponent
  }
}
