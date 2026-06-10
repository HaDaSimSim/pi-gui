import SwiftUI
import Foundation

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

// MARK: - Persistence keys

/// Namespaced UserDefaults keys. Kept as raw string constants so @AppStorage and
/// the plain UserDefaults readers in `AppSettings` / `applyAppTheme` agree exactly.
enum AppSettingsKeys {
    static let lang = "piswift.lang"
    static let themeMode = "piswift.themeMode"
    static let trueDark = "piswift.trueDark"
    static let reduceMotion = "piswift.reduceMotion"
    static let monoFont = "piswift.monoFont"
    static let fontSize = "piswift.fontSize"
}

// MARK: - Defaults

private enum SettingsDefaults {
    static let lang = "en"
    static let themeMode = "auto"   // auto | light | dark
    static let monoFont = "SF Mono"
    static let fontSize: Double = 14
}

// MARK: - Settings view

struct SettingsView: View {
    var body: some View {
        TabView {
            GeneralSettingsTab()
                .tabItem { Label("General", systemImage: "gearshape") }

            AppearanceSettingsTab()
                .tabItem { Label("Appearance", systemImage: "paintbrush") }

            FontsSettingsTab()
                .tabItem { Label("Fonts", systemImage: "textformat") }
        }
        .frame(width: 460)
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
    @AppStorage(AppSettingsKeys.trueDark) private var trueDark: Bool = false
    @AppStorage(AppSettingsKeys.reduceMotion) private var reduceMotion: Bool = false

    var body: some View {
        Form {
            Picker("Theme", selection: $themeMode) {
                Text("Auto").tag("auto")
                Text("Light").tag("light")
                Text("Dark").tag("dark")
            }

            Toggle("True dark (pure black)", isOn: $trueDark)
            Toggle("Reduce motion", isOn: $reduceMotion)
        }
        .formStyle(.grouped)
        .frame(minHeight: 160)
    }
}

// MARK: - Fonts

private struct FontsSettingsTab: View {
    @AppStorage(AppSettingsKeys.monoFont) private var monoFont: String = SettingsDefaults.monoFont
    @AppStorage(AppSettingsKeys.fontSize) private var fontSize: Double = SettingsDefaults.fontSize

    var body: some View {
        Form {
            TextField("Monospace font", text: $monoFont)
                .textFieldStyle(.roundedBorder)

            VStack(alignment: .leading) {
                Slider(value: $fontSize, in: 11...22, step: 1) {
                    Text("Base font size")
                } minimumValueLabel: {
                    Text("11")
                } maximumValueLabel: {
                    Text("22")
                }
                Text("\(Int(fontSize)) pt")
                    .foregroundStyle(.secondary)
                    .font(.caption)
            }

            Section("Preview") {
                VStack(alignment: .leading, spacing: 8) {
                    // Korean + latin sample at the chosen base size.
                    Text("안녕 world 123")
                        .font(.system(size: fontSize))
                    // Monospaced code line in the chosen family at the chosen size.
                    Text("let x = 42; // code")
                        .font(.custom(monoFont, size: fontSize))
                        .monospaced()
                }
                .padding(.vertical, 2)
            }
        }
        .formStyle(.grouped)
        .frame(minHeight: 260)
    }
}

// MARK: - Theme application

extension View {
    /// Applies the persisted theme mode + true-dark preference as a color scheme.
    /// Auto -> nil (follow system), Light -> .light, Dark -> .dark.
    /// NOTE: true-dark forces .dark regardless of the selected mode — it's a
    /// pure-black variant of dark, so it only makes sense under a dark scheme.
    func applyAppTheme() -> some View {
        let defaults = UserDefaults.standard
        let mode = defaults.string(forKey: AppSettingsKeys.themeMode) ?? SettingsDefaults.themeMode
        let trueDark = defaults.bool(forKey: AppSettingsKeys.trueDark)

        let scheme: ColorScheme?
        if trueDark {
            scheme = .dark
        } else {
            switch mode {
            case "light": scheme = .light
            case "dark": scheme = .dark
            default: scheme = nil // auto
            }
        }
        return self.preferredColorScheme(scheme)
    }
}

// MARK: - Read-only accessors

/// Plain (non-reactive) reads of the same settings for code that isn't a View.
struct AppSettings {
    static var fontSize: Double {
        let v = UserDefaults.standard.double(forKey: AppSettingsKeys.fontSize)
        return v == 0 ? SettingsDefaults.fontSize : v
    }

    static var monoFontName: String {
        UserDefaults.standard.string(forKey: AppSettingsKeys.monoFont) ?? SettingsDefaults.monoFont
    }

    static var lang: String {
        UserDefaults.standard.string(forKey: AppSettingsKeys.lang) ?? SettingsDefaults.lang
    }
}
