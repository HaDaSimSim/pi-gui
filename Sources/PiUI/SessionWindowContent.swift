import PiCore
import SwiftUI

// The main WindowGroup content view. When sessions are opened, they get their own
// NSWindow via SessionWindowController (native titlebar tabs). This view provides
// the sidebar for browsing and shows an empty state in the detail area.
// Active sessions are displayed in their per-tab windows, NOT here.

public struct SessionWindowContent: View {
  @Environment(AppModel.self) var model
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
      emptyState
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
