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
    } detail: {
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
    }
    .onReceive(NotificationCenter.default.publisher(for: .toggleInfoPanel)) { _ in
      withAnimation(.easeInOut(duration: 0.2)) { showInfo.toggle() }
    }
    .preferredColorScheme(colorScheme)
    .environment(\.locale, Locale(identifier: lang))
    .environment(model)
  }
}
