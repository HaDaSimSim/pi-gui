import Foundation
import PiCore
import SwiftUI

// Self-contained native Settings UI. Mirrors the web app's settings *features*
// (language, theme mode, true-dark, reduce-motion, mono font, font size) but uses
// the macOS Settings window with tabs instead of the web's custom modal.
//
// Wiring (in your App):
//
//     @main
//     struct PiSwiftApp: App {
//         var body: some Scene {
//             WindowGroup { ContentView() }
//             Settings { SettingsView() }   // adds the standard ⌘, Settings window
//         }
//     }
//
// Apply the theme at the root of your window content:
//
//     ContentView().applyAppTheme()

// MARK: - Defaults

private enum SettingsDefaults {
  static let lang = "en"
  static let themeMode = "auto"  // auto | light | dark
}

// MARK: - Settings view

public struct SettingsView: View {
  public init() {}
  public var body: some View {
    TabView {
      GeneralSettingsTab()
        .tabItem { Label("General", systemImage: "gearshape") }

      AppearanceSettingsTab()
        .tabItem { Label("Appearance", systemImage: "paintbrush") }

      PiSettingsTab()
        .tabItem { Label("pi", systemImage: "slider.horizontal.3") }

      ProvidersTab()
        .tabItem { Label("Providers", systemImage: "server.rack") }

      ShortcutsTab()
        .tabItem { Label("Shortcuts", systemImage: "keyboard") }
    }
    .frame(width: 560, height: 460)
  }
}

// MARK: - General

private struct GeneralSettingsTab: View {
  @AppStorage(AppSettingsKeys.lang) private var lang: String = SettingsDefaults.lang

  var body: some View {
    Form {
      Picker("Language", selection: $lang) {
        Text("English").tag("en")
        Text("한국어").tag("ko")
      }
    }
    .formStyle(.grouped)
    .frame(minHeight: 120)
  }
}

// MARK: - Appearance

private struct AppearanceSettingsTab: View {
  @AppStorage(AppSettingsKeys.themeMode) private var themeMode: String = SettingsDefaults.themeMode
  @AppStorage(AppSettingsKeys.reduceMotion) private var reduceMotion: Bool = false

  var body: some View {
    Form {
      Picker("Theme", selection: $themeMode) {
        Text("Auto").tag("auto")
        Text("Light").tag("light")
        Text("Dark").tag("dark")
      }
      Toggle("Reduce motion", isOn: $reduceMotion)
    }
    .formStyle(.grouped)
    .frame(minHeight: 160)
  }
}

// MARK: - Fonts

// MARK: - Theme application

extension View {
  /// Applies the persisted theme mode + true-dark preference as a color scheme.
  /// Auto -> nil (follow system), Light -> .light, Dark -> .dark.
  /// NOTE: true-dark forces .dark regardless of the selected mode — it's a
  /// pure-black variant of dark, so it only makes sense under a dark scheme.
  func applyAppTheme() -> some View {
    let defaults = UserDefaults.standard
    let mode = defaults.string(forKey: AppSettingsKeys.themeMode) ?? SettingsDefaults.themeMode

    let scheme: ColorScheme?
    switch mode {
    case "light": scheme = .light
    case "dark": scheme = .dark
    default: scheme = nil  // auto
    }
    return self.preferredColorScheme(scheme)
  }
}

// MARK: - Read-only accessors

/// Plain (non-reactive) reads of the same settings for code that isn't a View.
/// Fonts are fixed to Apple system defaults (no user font customization).
struct AppSettings {
  /// Fixed body font size (Apple default). Mono code uses the system monospaced face.
  static var fontSize: Double { 13 }
  static var monoFontName: String { "" }  // empty => use system monospaced
  static var lang: String {
    UserDefaults.standard.string(forKey: AppSettingsKeys.lang) ?? SettingsDefaults.lang
  }
}
