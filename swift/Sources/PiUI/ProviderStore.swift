import Foundation
import PiCore

// Read/write ~/.pi/agent/models.json (providers + models + API keys). Preserves unknown keys by
// round-tripping the whole object. API keys are stored as written (often "$ENV_VAR" interpolation
// or a literal); we never echo secret values in logs.
@MainActor
public final class ProviderStore: ObservableObject {
  @Published var raw: [String: Any] = [:]
  @Published var loadError: String?

  private var path: String { AgentPaths.modelsPath }

  struct ProviderView: Identifiable {
    let name: String
    var baseUrl: String
    var api: String
    var apiKey: String  // may be "$ENV", "!cmd", or literal
    var models: [ModelView]
    var id: String { name }
  }
  struct ModelView: Identifiable {
    var modelId: String
    var name: String
    var contextWindow: Int
    var id: String { modelId }
  }

  func load() {
    guard let data = FileManager.default.contents(atPath: path) else {
      raw = ["providers": [String: Any]()]
      return
    }
    if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
      raw = obj
      loadError = nil
    } else {
      loadError = "models.json is not valid JSON"
    }
  }

  var providers: [ProviderView] {
    guard let provs = raw["providers"] as? [String: Any] else { return [] }
    return provs.keys.sorted().compactMap { name in
      guard let p = provs[name] as? [String: Any] else { return nil }
      let models = (p["models"] as? [[String: Any]] ?? []).map { m in
        ModelView(
          modelId: (m["id"] as? String) ?? "",
          name: (m["name"] as? String) ?? (m["id"] as? String) ?? "",
          contextWindow: (m["contextWindow"] as? Int) ?? 0)
      }
      return ProviderView(
        name: name,
        baseUrl: (p["baseUrl"] as? String) ?? "",
        api: (p["api"] as? String) ?? "",
        apiKey: (p["apiKey"] as? String) ?? "",
        models: models)
    }
  }

  /// Update a provider's top-level fields (baseUrl/api/apiKey), preserving its models + extras.
  func updateProvider(_ name: String, baseUrl: String, api: String, apiKey: String) {
    var provs = (raw["providers"] as? [String: Any]) ?? [:]
    var p = (provs[name] as? [String: Any]) ?? [:]
    p["baseUrl"] = baseUrl
    p["api"] = api
    if apiKey.isEmpty { p.removeValue(forKey: "apiKey") } else { p["apiKey"] = apiKey }
    provs[name] = p
    raw["providers"] = provs
    save()
  }

  func addProvider(_ name: String) {
    guard !name.isEmpty else { return }
    var provs = (raw["providers"] as? [String: Any]) ?? [:]
    if provs[name] == nil {
      provs[name] = ["baseUrl": "", "api": "openai-completions", "models": [[String: Any]]()]
      raw["providers"] = provs
      save()
    }
  }

  func removeProvider(_ name: String) {
    var provs = (raw["providers"] as? [String: Any]) ?? [:]
    provs.removeValue(forKey: name)
    raw["providers"] = provs
    save()
  }

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
