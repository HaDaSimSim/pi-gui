import PiCore
import SwiftUI

// Root view hosted inside each SessionWindowController's NSHostingView.
// Contains the NavigationSplitView with shared sidebar + per-window session detail.

struct SessionWindowRootView: View {
  let runtime: RuntimeSession
  @State private var model: AppModel
  @State private var showInfo = false
  @AppStorage(AppSettingsKeys.themeMode) private var themeMode = "auto"
  @AppStorage(AppSettingsKeys.lang) private var lang = "en"

  init(runtime: RuntimeSession, model: AppModel) {
    self.runtime = runtime
    self._model = State(initialValue: model)
  }

  private var colorScheme: ColorScheme? {
    switch themeMode {
    case "light": return .light
    case "dark": return .dark
    default: return nil
    }
  }

  var body: some View {
    NavigationSplitView {
      SidebarView()
        .navigationSplitViewColumnWidth(min: 220, ideal: 260, max: 400)
    } detail: {
      VStack(spacing: 0) {
        // Header bar: info panel toggle (right only).
        HStack(spacing: 12) {
          Spacer()
          Button {
            withAnimation(.easeInOut(duration: 0.2)) { showInfo.toggle() }
          } label: {
            Image(systemName: showInfo ? "sidebar.trailing.badge.fullscreen" : "sidebar.right")
              .font(.system(size: 14))
              .frame(width: 30, height: 30)
              .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .foregroundStyle(showInfo ? .primary : .secondary)
          .help(
            showInfo ? "Hide info panel (\u{21e7}\u{2318}I)" : "Show info panel (\u{21e7}\u{2318}I)"
          )
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
              .frame(minWidth: 240, idealWidth: 320, maxWidth: 500)
          }
        }
      }
      .animation(.easeInOut(duration: 0.2), value: showInfo)
    }
    .onReceive(NotificationCenter.default.publisher(for: .toggleInfoPanel)) { _ in
      withAnimation(.easeInOut(duration: 0.2)) { showInfo.toggle() }
    }
    .preferredColorScheme(colorScheme)
    .environment(\.locale, Locale(identifier: lang))
    .environment(model)
  }
}
