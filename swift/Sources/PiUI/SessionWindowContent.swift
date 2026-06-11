import PiCore
import SwiftUI

// Per-window SwiftUI root: NavigationSplitView with sidebar + session detail + info panel.
// Each window has its own sidebar instance so you can browse/open sessions from any tab.
struct SessionWindowContent: View {
  @ObservedObject var runtime: RuntimeSession
  let cwd: String
  weak var controller: SessionWindowController?
  @EnvironmentObject var model: AppModel
  @AppStorage(AppSettingsKeys.themeMode) private var themeMode = "auto"
  @AppStorage(AppSettingsKeys.lang) private var lang = "en"

  private var showInfo: Bool { controller?.showInfoPanel ?? false }

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
        .navigationSplitViewColumnWidth(min: 220, ideal: 300, max: 480)
    } detail: {
      VStack(spacing: 0) {
        HSplitView {
          SessionTabView(runtime: runtime, cwd: cwd, controller: controller)
            .frame(minWidth: 420)
          if showInfo {
            InfoPanelView(runtime: runtime)
              .frame(minWidth: 260, idealWidth: 340, maxWidth: 560)
          }
        }
      }
    }
    .toolbar {
      ToolbarItem(placement: .navigation) {
        // Spacer to not collide with the system sidebar toggle.
        Color.clear.frame(width: 0)
      }
      ToolbarItem(placement: .primaryAction) {
        Button {
          controller?.toggleInfoPanel()
        } label: {
          Image(systemName: showInfo ? "sidebar.right.fill" : "sidebar.right")
        }
        .help("Toggle info panel (⇧⌘I)")
      }
    }
    .preferredColorScheme(colorScheme)
    .environment(\.locale, Locale(identifier: lang))
  }
}
