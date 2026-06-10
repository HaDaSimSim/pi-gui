import Foundation

// Session jsonl parsing. Mirrors SessionManager's read paths from server/runtime-manager.ts
// (SDK), reimplemented as pure file I/O. The parser is trivial: split on "\n", JSON.parse each
// line, skip broken lines. We add tail-N reading so a 200MB session never loads whole into RAM
// (the OOM the old Node backend hit on /api/session).

// MARK: - On-disk entry shapes

/// A raw session entry line. We decode only the discriminant + keep the raw JSON for
/// type-specific access, since pi has no extension namespacing (customType is a flat global).
struct SessionEntry {
    let type: String
    let id: String?
    let parentId: String?
    let timestamp: String?
    let raw: [String: Any]
}

/// Header (first line): {"type":"session","version":3,"id":...,"timestamp":...,"cwd":...}
struct SessionHeader {
    let id: String
    let version: Int
    let cwd: String?
    let timestamp: String?
}

enum SessionParseError: Error { case notFound, emptyFile }

struct SessionFile {
    let path: String

    init(path: String) { self.path = path }

    /// Read the header line cheaply (first line only).
    func header() throws -> SessionHeader {
        guard let line = try Self.firstLine(of: path) else { throw SessionParseError.emptyFile }
        guard let obj = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
              (obj["type"] as? String) == "session",
              let id = obj["id"] as? String else {
            throw SessionParseError.emptyFile
        }
        return SessionHeader(
            id: id,
            version: (obj["version"] as? Int) ?? 0,
            cwd: obj["cwd"] as? String,
            timestamp: obj["timestamp"] as? String
        )
    }

    /// Parse ALL entries (use only for small sessions / when the full tree is needed).
    func allEntries() throws -> [SessionEntry] {
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        return Self.parseEntries(data)
    }

    /// Parse only the last `maxLines` lines. This is the OOM-safe path: for scrollback the
    /// frontend renders entries linearly (no parentId tree walk), so tail is semantically valid.
    func tailEntries(maxLines: Int = 2000, maxBytes: Int = 8 * 1024 * 1024) throws -> [SessionEntry] {
        let data = try Self.tailBytes(path: path, maxBytes: maxBytes)
        var entries = Self.parseEntries(data)
        if entries.count > maxLines {
            entries = Array(entries.suffix(maxLines))
        }
        return entries
    }

    // MARK: - Static helpers

    static func parseEntries(_ data: Data) -> [SessionEntry] {
        guard let text = String(data: data, encoding: .utf8) else { return [] }
        var out: [SessionEntry] = []
        for rawLine in text.split(separator: "\n", omittingEmptySubsequences: true) {
            let line = rawLine.hasSuffix("\r") ? String(rawLine.dropLast()) : String(rawLine)
            guard let obj = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
                  let type = obj["type"] as? String else { continue }
            out.append(SessionEntry(
                type: type,
                id: obj["id"] as? String,
                parentId: obj["parentId"] as? String,
                timestamp: obj["timestamp"] as? String,
                raw: obj
            ))
        }
        return out
    }

    /// Read the first line without loading the whole file.
    static func firstLine(of path: String) throws -> String? {
        guard let fh = FileHandle(forReadingAtPath: path) else { throw SessionParseError.notFound }
        defer { try? fh.close() }
        var buffer = Data()
        while true {
            let chunk = fh.readData(ofLength: 64 * 1024)
            if chunk.isEmpty { break }
            buffer.append(chunk)
            if let nl = buffer.firstIndex(of: 0x0A) {
                return String(data: buffer[..<nl], encoding: .utf8)
            }
            if buffer.count > 4 * 1024 * 1024 { break } // header shouldn't exceed this
        }
        return String(data: buffer, encoding: .utf8)
    }

    /// Read up to maxBytes from the END of the file, aligned to a line boundary.
    static func tailBytes(path: String, maxBytes: Int) throws -> Data {
        guard let fh = FileHandle(forReadingAtPath: path) else { throw SessionParseError.notFound }
        defer { try? fh.close() }
        let size = (try fh.seekToEnd())
        let start = size > UInt64(maxBytes) ? size - UInt64(maxBytes) : 0
        try fh.seek(toOffset: start)
        var data = fh.readDataToEndOfFile()
        // If we cut mid-line, drop the partial leading line.
        if start > 0, let nl = data.firstIndex(of: 0x0A) {
            data = data.subdata(in: data.index(after: nl)..<data.endIndex)
        }
        return data
    }
}
