import PiCore
import SwiftUI

// Per-window SwiftUI root: sidebar + header + message area + info panel.
// Sidebar state lives in AppModel (shared across all tabs/windows).
struct SessionWindowContent: View {
  var runtime: RuntimeSession
  let cwd: String
  weak var controller: SessionWindowController?
  @Environment(AppModel.self) var model
  @State private var showSidebar = true
  @State private var showInfo = false
  @AppStorage(AppSettingsKeys.themeMode) private var themeMode = "auto"
  @AppStorage(AppSettingsKeys.lang) private var lang = "en"

  private var colorScheme: ColorScheme? {
    switch themeMode {
    case "light": return .light
    case "dark": return .dark
    default: return nil
    }
  }

  var body: some View {
    HStack(spacing: 0) {
      // Left sidebar (toggleable).
      if showSidebar {
        SidebarView()
          .frame(minWidth: 200, idealWidth: 240, maxWidth: 360)
          .transition(.move(edge: .leading).combined(with: .opacity))
        Divider()
      }
      // Main content area.
      VStack(spacing: 0) {
        // Header bar: sidebar toggle (left) — title — info panel toggle (right).
        HStack(spacing: 12) {
          Button {
            withAnimation(.easeInOut(duration: 0.2)) { showSidebar.toggle() }
          } label: {
            Image(systemName: "sidebar.left")
              .font(.system(size: 13))
              .frame(width: 28, height: 28)
          }
          .buttonStyle(.plain)
          .foregroundStyle(.secondary)
          .help("Toggle sidebar")
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
        // Message area + optional info panel.
        HStack(spacing: 0) {
          SessionTabView(runtime: runtime, cwd: cwd, controller: controller)
          if showInfo {
            Divider()
            InfoPanelView(runtime: runtime)
              .frame(minWidth: 220, idealWidth: 280, maxWidth: 400)
              .transition(.move(edge: .trailing).combined(with: .opacity))
          }
        }
      }
    }
    .animation(.easeInOut(duration: 0.2), value: showSidebar)
    .animation(.easeInOut(duration: 0.2), value: showInfo)
    .onReceive(NotificationCenter.default.publisher(for: .toggleInfoPanel)) { _ in
      withAnimation(.easeInOut(duration: 0.2)) { showInfo.toggle() }
    }
    .onReceive(NotificationCenter.default.publisher(for: .toggleSidebar)) { _ in
      withAnimation(.easeInOut(duration: 0.2)) { showSidebar.toggle() }
    }
    .preferredColorScheme(colorScheme)
    .environment(\.locale, Locale(identifier: lang))
  }
}

extension Notification.Name {
  static let toggleInfoPanel = Notification.Name("pi.toggleInfoPanel")
  static let toggleSidebar = Notification.Name("pi.toggleSidebar")
}
