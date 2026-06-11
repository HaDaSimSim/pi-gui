import PiCore
import SwiftUI

// Single-window NavigationSplitView root: Finder-style sidebar (system sourceList)
// + detail panel showing the active session. Sidebar selection drives which session
// is displayed. The NavigationSplitView gives us the standard sidebar toggle button
// in the toolbar automatically.

public struct SessionWindowContent: View {
  @Environment(AppModel.self) var model
  @State private var showInfo = false
  @AppStorage(AppSettingsKeys.themeMode) private var themeMode = "auto"
  @AppStorage(AppSettingsKeys.lang) private var lang = "en"

  public init() {}

  private var colorScheme: ColorScheme? {
    switch themeMode {
    case "light": return .light
    case "dark": return .dark
    default: return nil
    }
  }

  public var body: some View {
    NavigationSplitView {
      SidebarView()
    } detail: {
      if let runtime = model.activeSession {
        VStack(spacing: 0) {
          // Header bar with info panel toggle.
          HStack(spacing: 12) {
            Spacer()
            Button {
              withAnimation(.easeInOut(duration: 0.2)) { showInfo.toggle() }
            } label: {
              Image(systemName: showInfo ? "sidebar.right.fill" : "sidebar.right")
                .font(.system(size: 13))
                .frame(width: 28, height: 28)
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .help("Toggle info panel (\u{21e7}\u{2318}I)")
          }
          .padding(.horizontal, 10)
          .frame(height: 36)
          .background(.bar)
          Divider()
          // Session content + optional info panel.
          HSplitView {
            SessionTabView(runtime: runtime, cwd: runtime.cwd, model: model)
              .frame(minWidth: 400)
              .id(runtime.id)
            if showInfo {
              InfoPanelView(runtime: runtime)
                .frame(minWidth: 200, idealWidth: 260, maxWidth: 450)
            }
          }
        }
        .animation(.easeInOut(duration: 0.2), value: showInfo)
      } else {
        emptyState
      }
    }
    .onReceive(NotificationCenter.default.publisher(for: .toggleInfoPanel)) { _ in
      withAnimation(.easeInOut(duration: 0.2)) { showInfo.toggle() }
    }
    .preferredColorScheme(colorScheme)
    .environment(\.locale, Locale(identifier: lang))
  }

  @ViewBuilder
  private var emptyState: some View {
    VStack(spacing: 16) {
      Image(systemName: "bubble.left.and.bubble.right")
        .font(.system(size: 48))
        .foregroundStyle(.quaternary)
      Text("No session selected")
        .font(.title3)
        .foregroundStyle(.secondary)
      Text("Open or create a session from the sidebar")
        .font(.callout)
        .foregroundStyle(.tertiary)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

extension Notification.Name {
  public static let toggleInfoPanel = Notification.Name("pi.toggleInfoPanel")
}
