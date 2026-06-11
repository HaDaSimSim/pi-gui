import PiCore
import SwiftUI

// Per-window SwiftUI root: HSplitView with sidebar + session detail + info panel.
// Each window has its own sidebar instance so you can browse/open sessions from any tab.
// Uses HSplitView instead of NavigationSplitView to avoid toolbar/header layout issues
// when the sidebar is shown (NavigationSplitView's detail toolbar shifts unpredictably).
struct SessionWindowContent: View {
  var runtime: RuntimeSession
  let cwd: String
  weak var controller: SessionWindowController?
  @Environment(AppModel.self) var model
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
    HSplitView {
      SidebarView()
        .frame(minWidth: 220, idealWidth: 280, maxWidth: 480)
      VStack(spacing: 0) {
        // Fixed header bar that always covers content below (never shifts with sidebar).
        HStack {
          Spacer()
          Button {
            showInfo.toggle()
          } label: {
            Image(systemName: showInfo ? "sidebar.right.fill" : "sidebar.right")
              .font(.system(size: 14))
              .frame(width: 28, height: 28)
          }
          .buttonStyle(.plain)
          .foregroundStyle(.secondary)
          .modifier(GlassCircleButtonModifier())
          .help("Toggle info panel (\u{21e7}\u{2318}I)")
          .accessibilityLabel(showInfo ? "Hide info panel" : "Show info panel")
          .accessibilityHint("Toggles the right-side information panel")
        }
        .padding(.horizontal, 12)
        .frame(height: 38)
        .background(.bar)
        Divider()
        HStack(spacing: 0) {
          SessionTabView(runtime: runtime, cwd: cwd, controller: controller)
            .frame(minWidth: 420)
          if showInfo {
            Divider()
            InfoPanelView(runtime: runtime)
              .frame(minWidth: 260, idealWidth: 340, maxWidth: 560)
              .transition(.move(edge: .trailing).combined(with: .opacity))
          }
        }
        .animation(.easeInOut(duration: 0.2), value: showInfo)
      }
    }
    .onReceive(NotificationCenter.default.publisher(for: .toggleInfoPanel)) { _ in
      showInfo.toggle()
    }
    .preferredColorScheme(colorScheme)
    .environment(\.locale, Locale(identifier: lang))
  }
}

extension Notification.Name {
  static let toggleInfoPanel = Notification.Name("pi.toggleInfoPanel")
}

// MARK: - Liquid Glass modifier for circular toolbar buttons (macOS 26+ with fallback)

private struct GlassCircleButtonModifier: ViewModifier {
  func body(content: Content) -> some View {
    if #available(macOS 26, *) {
      content.glassEffect(.regular.interactive(), in: .circle)
    } else {
      content
    }
  }
}
