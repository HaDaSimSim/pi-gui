import Foundation

// A dynamic JSON value for decoding loosely-typed session entries (the backend's
// getEntries() returns heterogeneous records). Lets us read fields by key path
// without a rigid schema, mirroring the web client's `any` handling.
enum JSONValue: Codable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .null
        } else if let b = try? c.decode(Bool.self) {
            self = .bool(b)
        } else if let n = try? c.decode(Double.self) {
            self = .number(n)
        } else if let s = try? c.decode(String.self) {
            self = .string(s)
        } else if let o = try? c.decode([String: JSONValue].self) {
            self = .object(o)
        } else if let a = try? c.decode([JSONValue].self) {
            self = .array(a)
        } else {
            self = .null
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .number(let n): try c.encode(n)
        case .bool(let b): try c.encode(b)
        case .object(let o): try c.encode(o)
        case .array(let a): try c.encode(a)
        case .null: try c.encodeNil()
        }
    }

    // ── Accessors ────────────────────────────────────────────────
    var stringValue: String? { if case .string(let s) = self { return s }; return nil }
    var numberValue: Double? { if case .number(let n) = self { return n }; return nil }
    var boolValue: Bool? { if case .bool(let b) = self { return b }; return nil }
    var arrayValue: [JSONValue]? { if case .array(let a) = self { return a }; return nil }
    var objectValue: [String: JSONValue]? { if case .object(let o) = self { return o }; return nil }

    subscript(_ key: String) -> JSONValue? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    subscript(_ index: Int) -> JSONValue? {
        if case .array(let a) = self, index >= 0, index < a.count { return a[index] }
        return nil
    }

    // Build from an arbitrary Foundation object (for WS events parsed via JSONSerialization).
    static func from(_ any: Any) -> JSONValue {
        switch any {
        case let s as String: return .string(s)
        case let b as Bool: return .bool(b)
        case let n as NSNumber:
            // NSNumber bridges bools too; distinguish.
            if CFGetTypeID(n) == CFBooleanGetTypeID() { return .bool(n.boolValue) }
            return .number(n.doubleValue)
        case let d as Double: return .number(d)
        case let i as Int: return .number(Double(i))
        case let o as [String: Any]: return .object(o.mapValues { JSONValue.from($0) })
        case let a as [Any]: return .array(a.map { JSONValue.from($0) })
        default: return .null
        }
    }
}
