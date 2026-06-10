import SwiftUI
import AppKit
import Foundation

// A self-contained GitHub-flavored Markdown renderer for AI-assistant output.
//
// SECURITY: the source text is UNTRUSTED. We never execute it, never fetch
// remote resources, and never auto-open links. Links are styled but inert —
// `AttributedString(markdown:)` keeps the URL as metadata, and we strip the
// implicit open behavior by rendering through plain `Text` (no `.openURL`).
//
// Strategy: split the source into top-level blocks (fenced code vs prose),
// render prose through `AttributedString(markdown:)` with inline-only syntax
// so paragraphs/inline formatting survive, and render fenced code through a
// dedicated `CodeBlockView` with a hover Copy button.

struct MarkdownView: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(MarkdownBlock.parse(text)) { block in
                blockView(block)
            }
        }
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func blockView(_ block: MarkdownBlock) -> some View {
        switch block.kind {
        case .code(let code, let language):
            CodeBlockView(code: code, language: language)
        case .prose(let raw):
            ProseBlockView(raw: raw)
        case .heading(let raw, let level):
            HeadingView(raw: raw, level: level)
        case .blockquote(let raw):
            BlockquoteView(raw: raw)
        case .bulletList(let items):
            ListView(items: items, ordered: false)
        case .orderedList(let items):
            ListView(items: items, ordered: true)
        case .table(let header, let rows):
            TableView(header: header, rows: rows)
        case .horizontalRule:
            Divider().padding(.vertical, 4)
        }
    }
}

// MARK: - Block model

struct MarkdownBlock: Identifiable {
    enum Kind {
        case prose(String)
        case heading(String, level: Int)
        case code(String, language: String?)
        case blockquote(String)
        case bulletList([String])
        case orderedList([String])
        case table(header: [String], rows: [[String]])
        case horizontalRule
    }

    let id = UUID()
    let kind: Kind

    /// Split raw markdown into top-level blocks. The parser is intentionally
    /// small: it understands fenced code, headings, lists, blockquotes, tables,
    /// horizontal rules, and otherwise groups consecutive lines into prose.
    static func parse(_ source: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        // Normalize newlines so CRLF input from the model doesn't leak \r.
        let normalized = source.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
        let lines = normalized.components(separatedBy: "\n")

        var i = 0
        var proseBuffer: [String] = []

        func flushProse() {
            let joined = proseBuffer.joined(separator: "\n")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !joined.isEmpty {
                blocks.append(MarkdownBlock(kind: .prose(joined)))
            }
            proseBuffer.removeAll(keepingCapacity: true)
        }

        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            // Fenced code block: ``` or ~~~ with optional language.
            if let fence = fenceMarker(trimmed) {
                flushProse()
                let language = fenceLanguage(trimmed, fence: fence)
                var codeLines: [String] = []
                i += 1
                while i < lines.count {
                    let inner = lines[i].trimmingCharacters(in: .whitespaces)
                    if inner.hasPrefix(fence) && isClosingFence(inner, fence: fence) {
                        i += 1
                        break
                    }
                    codeLines.append(lines[i])
                    i += 1
                }
                let code = codeLines.joined(separator: "\n")
                blocks.append(MarkdownBlock(kind: .code(code, language: language)))
                continue
            }

            // Horizontal rule: ---, ***, ___ (3+).
            if isHorizontalRule(trimmed) {
                flushProse()
                blocks.append(MarkdownBlock(kind: .horizontalRule))
                i += 1
                continue
            }

            // ATX heading: #..###### followed by space.
            if let (headingText, level) = atxHeading(trimmed) {
                flushProse()
                blocks.append(MarkdownBlock(kind: .heading(headingText, level: level)))
                i += 1
                continue
            }

            // Blockquote: one or more leading '>' lines.
            if trimmed.hasPrefix(">") {
                flushProse()
                var quoteLines: [String] = []
                while i < lines.count {
                    let qt = lines[i].trimmingCharacters(in: .whitespaces)
                    guard qt.hasPrefix(">") else { break }
                    var stripped = String(qt.dropFirst())
                    if stripped.hasPrefix(" ") { stripped.removeFirst() }
                    quoteLines.append(stripped)
                    i += 1
                }
                blocks.append(MarkdownBlock(kind: .blockquote(quoteLines.joined(separator: "\n"))))
                continue
            }

            // GFM table: a header row containing '|' followed by a separator row.
            if looksLikeTableHeader(line, next: i + 1 < lines.count ? lines[i + 1] : nil) {
                flushProse()
                let header = splitTableRow(line)
                i += 2 // skip header + separator
                var rows: [[String]] = []
                while i < lines.count {
                    let rowLine = lines[i]
                    guard rowLine.contains("|"),
                          !rowLine.trimmingCharacters(in: .whitespaces).isEmpty else { break }
                    rows.append(splitTableRow(rowLine))
                    i += 1
                }
                blocks.append(MarkdownBlock(kind: .table(header: header, rows: rows)))
                continue
            }

            // Bullet list: -, *, + followed by space.
            if isBulletItem(trimmed) {
                flushProse()
                var items: [String] = []
                while i < lines.count {
                    let t = lines[i].trimmingCharacters(in: .whitespaces)
                    guard isBulletItem(t) else { break }
                    items.append(stripBulletMarker(t))
                    i += 1
                }
                blocks.append(MarkdownBlock(kind: .bulletList(items)))
                continue
            }

            // Ordered list: 1. / 1) followed by space.
            if isOrderedItem(trimmed) {
                flushProse()
                var items: [String] = []
                while i < lines.count {
                    let t = lines[i].trimmingCharacters(in: .whitespaces)
                    guard isOrderedItem(t) else { break }
                    items.append(stripOrderedMarker(t))
                    i += 1
                }
                blocks.append(MarkdownBlock(kind: .orderedList(items)))
                continue
            }

            // Blank line separates prose paragraphs.
            if trimmed.isEmpty {
                flushProse()
                i += 1
                continue
            }

            proseBuffer.append(line)
            i += 1
        }
        flushProse()
        return blocks
    }

    // MARK: Block detection helpers

    private static func fenceMarker(_ line: String) -> String? {
        if line.hasPrefix("```") { return "```" }
        if line.hasPrefix("~~~") { return "~~~" }
        return nil
    }

    private static func fenceLanguage(_ line: String, fence: String) -> String? {
        let lang = String(line.dropFirst(fence.count)).trimmingCharacters(in: .whitespaces)
        return lang.isEmpty ? nil : lang
    }

    private static func isClosingFence(_ line: String, fence: String) -> Bool {
        // A closing fence is only the fence chars (no language allowed).
        return line.allSatisfy { String($0) == String(fence.first!) }
    }

    private static func isHorizontalRule(_ line: String) -> Bool {
        guard line.count >= 3 else { return false }
        let stripped = line.replacingOccurrences(of: " ", with: "")
        guard stripped.count >= 3 else { return false }
        return stripped.allSatisfy { $0 == "-" }
            || stripped.allSatisfy { $0 == "*" }
            || stripped.allSatisfy { $0 == "_" }
    }

    private static func atxHeading(_ line: String) -> (String, Int)? {
        guard line.hasPrefix("#") else { return nil }
        var level = 0
        for ch in line {
            if ch == "#" { level += 1 } else { break }
        }
        guard level >= 1 && level <= 6 else { return nil }
        let rest = String(line.dropFirst(level))
        guard rest.hasPrefix(" ") || rest.isEmpty else { return nil }
        let textValue = rest.trimmingCharacters(in: .whitespaces)
        // Strip trailing closing hashes (e.g. "## Title ##").
        let cleaned = textValue.drop(while: { $0 == "#" })
        let final = String(cleaned).trimmingCharacters(in: .whitespaces).isEmpty
            ? textValue
            : textValue
        return (trimTrailingHashes(final), level)
    }

    private static func trimTrailingHashes(_ s: String) -> String {
        var out = s
        while out.hasSuffix("#") { out.removeLast() }
        return out.trimmingCharacters(in: .whitespaces)
    }

    private static func isBulletItem(_ line: String) -> Bool {
        guard line.count >= 2 else { return false }
        let marker = line.first!
        guard marker == "-" || marker == "*" || marker == "+" else { return false }
        let second = line[line.index(after: line.startIndex)]
        return second == " "
    }

    private static func stripBulletMarker(_ line: String) -> String {
        return String(line.dropFirst(2)).trimmingCharacters(in: .whitespaces)
    }

    private static func isOrderedItem(_ line: String) -> Bool {
        var digits = 0
        var idx = line.startIndex
        while idx < line.endIndex, line[idx].isNumber {
            digits += 1
            idx = line.index(after: idx)
        }
        guard digits > 0, idx < line.endIndex else { return false }
        let delim = line[idx]
        guard delim == "." || delim == ")" else { return false }
        let afterDelim = line.index(after: idx)
        guard afterDelim < line.endIndex else { return false }
        return line[afterDelim] == " "
    }

    private static func stripOrderedMarker(_ line: String) -> String {
        var idx = line.startIndex
        while idx < line.endIndex, line[idx].isNumber {
            idx = line.index(after: idx)
        }
        // skip delimiter + space
        if idx < line.endIndex { idx = line.index(after: idx) }
        if idx < line.endIndex { idx = line.index(after: idx) }
        return String(line[idx...]).trimmingCharacters(in: .whitespaces)
    }

    private static func looksLikeTableHeader(_ line: String, next: String?) -> Bool {
        guard let next else { return false }
        guard line.contains("|") else { return false }
        let sep = next.trimmingCharacters(in: .whitespaces)
        guard sep.contains("|") || sep.contains("-") else { return false }
        // Separator row is only |, -, :, and spaces, and contains at least one '-'.
        let allowed = Set("|-: ")
        guard sep.contains("-"), sep.allSatisfy({ allowed.contains($0) }) else { return false }
        return true
    }

    private static func splitTableRow(_ line: String) -> [String] {
        var trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix("|") { trimmed.removeFirst() }
        if trimmed.hasSuffix("|") { trimmed.removeLast() }
        return trimmed
            .components(separatedBy: "|")
            .map { $0.trimmingCharacters(in: .whitespaces) }
    }
}

// MARK: - Inline rendering

/// Render an inline markdown fragment into an AttributedString with inline-only
/// syntax (bold/italic/inline-code/links survive; block syntax is preserved as
/// whitespace). Links keep their URL as metadata but are NOT auto-openable —
/// we render through `Text`, which does not register an open handler.
func renderInlineMarkdown(_ raw: String) -> AttributedString {
    var options = AttributedString.MarkdownParsingOptions()
    options.interpretedSyntax = .inlineOnlyPreservingWhitespace
    options.allowsExtendedAttributes = true
    if var attributed = try? AttributedString(markdown: raw, options: options) {
        // Style links: keep the visible text + a hint color/underline, but the
        // URL stays as inert metadata (no tap-to-open is wired up).
        for run in attributed.runs {
            if attributed[run.range].link != nil {
                attributed[run.range].foregroundColor = .accentColor
                attributed[run.range].underlineStyle = .single
            }
        }
        return attributed
    }
    // Fallback: render as plain text if parsing fails.
    return AttributedString(raw)
}

private struct ProseBlockView: View {
    let raw: String

    var body: some View {
        Text(renderInlineMarkdown(raw))
            .font(.body)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct HeadingView: View {
    let raw: String
    let level: Int

    private var font: Font {
        switch level {
        case 1: return .system(.title, design: .default).weight(.bold)
        case 2: return .system(.title2, design: .default).weight(.bold)
        case 3: return .system(.title3, design: .default).weight(.semibold)
        case 4: return .system(.headline)
        case 5: return .system(.subheadline).weight(.semibold)
        default: return .system(.body).weight(.semibold)
        }
    }

    var body: some View {
        Text(renderInlineMarkdown(raw))
            .font(font)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, level <= 2 ? 4 : 0)
    }
}

private struct BlockquoteView: View {
    let raw: String

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            RoundedRectangle(cornerRadius: 2)
                .fill(Color.secondary.opacity(0.4))
                .frame(width: 3)
            Text(renderInlineMarkdown(raw))
                .font(.body)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.leading, 2)
    }
}

private struct ListView: View {
    let items: [String]
    let ordered: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                HStack(alignment: .top, spacing: 8) {
                    Text(ordered ? "\(index + 1)." : "•")
                        .font(.body.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .frame(minWidth: ordered ? 22 : 12, alignment: .trailing)
                    Text(renderInlineMarkdown(item))
                        .font(.body)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .padding(.leading, 4)
    }
}

private struct TableView: View {
    let header: [String]
    let rows: [[String]]

    private var columnCount: Int {
        max(header.count, rows.map(\.count).max() ?? 0)
    }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 0) {
                tableRow(header, isHeader: true)
                Divider()
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    tableRow(row, isHeader: false)
                }
            }
            .overlay(
                RoundedRectangle(cornerRadius: 6)
                    .stroke(Color.secondary.opacity(0.25), lineWidth: 1)
            )
        }
    }

    @ViewBuilder
    private func tableRow(_ cells: [String], isHeader: Bool) -> some View {
        HStack(alignment: .top, spacing: 0) {
            ForEach(0..<columnCount, id: \.self) { col in
                let value = col < cells.count ? cells[col] : ""
                Text(renderInlineMarkdown(value))
                    .font(isHeader ? .body.weight(.semibold) : .body)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .frame(minWidth: 80, alignment: .leading)
                if col < columnCount - 1 {
                    Divider()
                }
            }
        }
        .background(isHeader ? Color.secondary.opacity(0.08) : Color.clear)
    }
}

// MARK: - Code block

struct CodeBlockView: View {
    let code: String
    let language: String?

    @State private var isHovering = false
    @State private var didCopy = false

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(highlight(code, language: language))
                .font(.system(.body, design: .monospaced))
                .textSelection(.enabled)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(Color(nsColor: .textBackgroundColor))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color.secondary.opacity(0.2), lineWidth: 1)
        )
        .overlay(alignment: .topTrailing) {
            copyButton
                .padding(8)
                .opacity(isHovering || didCopy ? 1 : 0)
                .animation(.easeInOut(duration: 0.15), value: isHovering)
                .animation(.easeInOut(duration: 0.15), value: didCopy)
        }
        .onHover { isHovering = $0 }
    }

    private var copyButton: some View {
        Button(action: copy) {
            Image(systemName: didCopy ? "checkmark" : "doc.on.doc")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(didCopy ? Color.green : Color.secondary)
                .padding(6)
                .background(
                    RoundedRectangle(cornerRadius: 6)
                        .fill(.thinMaterial)
                )
        }
        .buttonStyle(.plain)
        .help(didCopy ? "Copied" : "Copy code")
    }

    private func copy() {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(code, forType: .string)
        didCopy = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            didCopy = false
        }
    }
}

// MARK: - Lightweight syntax highlighting

/// A tiny, self-contained tokenizer. It highlights strings, comments, numbers,
/// and a small set of common keywords. It is deliberately language-agnostic and
/// best-effort — no external dependencies, no remote anything.
func highlight(_ code: String, language: String?) -> AttributedString {
    var result = AttributedString(code)
    result.font = .system(.body, design: .monospaced)

    // Skip highlighting for very large blocks to keep rendering snappy.
    guard code.count <= 20_000 else { return result }

    let keywords = SyntaxKeywords.forLanguage(language)
    let nsString = code as NSString
    let fullRange = NSRange(location: 0, length: nsString.length)

    func apply(_ color: Color, to nsRange: NSRange) {
        guard let range = Range(nsRange, in: code),
              let lo = AttributedString.Index(range.lowerBound, within: result),
              let hi = AttributedString.Index(range.upperBound, within: result) else { return }
        result[lo..<hi].foregroundColor = color
    }

    let commentColor = Color.secondary
    let stringColor = Color(nsColor: .systemGreen)
    let numberColor = Color(nsColor: .systemPurple)
    let keywordColor = Color(nsColor: .systemPink)

    // Keywords (whole-word).
    if !keywords.isEmpty {
        let pattern = "\\b(" + keywords.map { NSRegularExpression.escapedPattern(for: $0) }.joined(separator: "|") + ")\\b"
        if let regex = try? NSRegularExpression(pattern: pattern) {
            for match in regex.matches(in: code, range: fullRange) {
                apply(keywordColor, to: match.range)
            }
        }
    }

    // Numbers.
    if let regex = try? NSRegularExpression(pattern: "\\b\\d+(\\.\\d+)?\\b") {
        for match in regex.matches(in: code, range: fullRange) {
            apply(numberColor, to: match.range)
        }
    }

    // Strings: "...", '...', `...` (non-greedy, single line).
    if let regex = try? NSRegularExpression(pattern: "\"[^\"\\n]*\"|'[^'\\n]*'|`[^`\\n]*`") {
        for match in regex.matches(in: code, range: fullRange) {
            apply(stringColor, to: match.range)
        }
    }

    // Line comments: // ... and # ... (apply last so they win over keywords).
    if let regex = try? NSRegularExpression(pattern: "//[^\\n]*|#[^\\n]*") {
        for match in regex.matches(in: code, range: fullRange) {
            apply(commentColor, to: match.range)
        }
    }

    return result
}

private enum SyntaxKeywords {
    static func forLanguage(_ language: String?) -> [String] {
        guard let language = language?.lowercased() else { return common }
        switch language {
        case "swift":
            return ["func", "let", "var", "if", "else", "guard", "return", "struct",
                    "class", "enum", "protocol", "extension", "import", "for", "while",
                    "switch", "case", "default", "do", "try", "catch", "throw", "throws",
                    "async", "await", "self", "init", "deinit", "static", "private",
                    "public", "internal", "fileprivate", "open", "in", "where", "nil",
                    "true", "false", "some", "any", "actor", "weak", "unowned", "lazy"]
        case "js", "javascript", "ts", "typescript", "jsx", "tsx":
            return ["function", "const", "let", "var", "if", "else", "return", "class",
                    "extends", "import", "export", "from", "for", "while", "switch",
                    "case", "default", "do", "try", "catch", "throw", "async", "await",
                    "new", "this", "null", "undefined", "true", "false", "typeof",
                    "instanceof", "interface", "type", "enum", "public", "private",
                    "protected", "static", "readonly", "void"]
        case "python", "py":
            return ["def", "class", "if", "elif", "else", "return", "import", "from",
                    "for", "while", "try", "except", "finally", "raise", "with", "as",
                    "lambda", "yield", "async", "await", "None", "True", "False", "and",
                    "or", "not", "in", "is", "pass", "break", "continue", "global", "nonlocal"]
        case "rust", "rs":
            return ["fn", "let", "mut", "if", "else", "match", "return", "struct",
                    "enum", "trait", "impl", "use", "for", "while", "loop", "break",
                    "continue", "pub", "mod", "async", "await", "self", "Self", "where",
                    "true", "false", "const", "static", "ref", "move", "dyn", "type"]
        case "go", "golang":
            return ["func", "var", "const", "if", "else", "return", "struct", "type",
                    "interface", "import", "package", "for", "range", "switch", "case",
                    "default", "go", "defer", "chan", "map", "nil", "true", "false",
                    "break", "continue", "select", "fallthrough"]
        case "json":
            return ["true", "false", "null"]
        default:
            return common
        }
    }

    static let common: [String] = [
        "if", "else", "for", "while", "return", "function", "func", "def", "class",
        "import", "export", "const", "let", "var", "true", "false", "null", "nil",
        "switch", "case", "break", "continue", "try", "catch", "throw", "new"
    ]
}
