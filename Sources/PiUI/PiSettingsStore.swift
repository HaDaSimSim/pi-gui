import Foundation
import PiCore

// Read/write ~/.pi/agent/settings.json (the pi global settings). We edit the common fields via
// typed accessors and preserve all unknown keys (round-trip the full JSON object). This is the
// same file pi's SettingsManager reads, so changes apply to new runtimes.
@MainActor
@Observable
public final class PiSettingsStore {
  var raw: [String: Any] = [:]
  var loadError: String?

  private var path: String { AgentPaths.settingsPath }

  func load() {
    guard let data = FileManager.default.contents(atPath: path) else {
      raw = [:]
      return
    }
    if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
      raw = obj
      loadError = nil
    } else {
      loadError = "settings.json is not valid JSON"
    }
  }

  func string(_ key: String) -> String { (raw[key] as? String) ?? "" }
  func bool(_ key: String) -> Bool { (raw[key] as? Bool) ?? false }

  func setString(_ key: String, _ value: String) {
    if value.isEmpty { raw.removeValue(forKey: key) } else { raw[key] = value }
    save()
  }
  func setBool(_ key: String, _ value: Bool) {
    raw[key] = value
    save()
  }

  /// Atomic, pretty-printed write preserving key order as much as JSONSerialization allows.
  func save() {
    guard
      let data = try? JSONSerialization.data(
        withJSONObject: raw,
        options: [.prettyPrinted, .sortedKeys])
    else { return }
    let tmp = path + ".tmp"
    do {
      try data.write(to: URL(fileURLWithPath: tmp))
      _ = try FileManager.default.replaceItemAt(
        URL(fileURLWithPath: path),
        withItemAt: URL(fileURLWithPath: tmp))
    } catch {
      try? data.write(to: URL(fileURLWithPath: path))
      try? FileManager.default.removeItem(atPath: tmp)
    }
  }

  /// Replace the entire settings object from raw JSON text (the escape hatch). Returns an
  /// error string on parse failure, nil on success.
  func replaceFromJSON(_ text: String) -> String? {
    guard let data = text.data(using: .utf8) else { return "invalid text" }
    guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      return "not a valid JSON object"
    }
    raw = obj
    save()
    return nil
  }

  var prettyJSON: String {
    guard
      let data = try? JSONSerialization.data(
        withJSONObject: raw,
        options: [.prettyPrinted, .sortedKeys]),
      let s = String(data: data, encoding: .utf8)
    else { return "{}" }
    return s
  }
}
