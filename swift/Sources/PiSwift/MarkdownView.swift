import AppKit
import Foundation
import SwiftUI

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
    case .orderedList(let items, let startIndex):
      ListView(items: items, ordered: true, startIndex: startIndex)
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
    case orderedList([String], startIndex: Int)
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
        i += 2  // skip header + separator
        var rows: [[String]] = []
        while i < lines.count {
          let rowLine = lines[i]
          guard rowLine.contains("|"),
            !rowLine.trimmingCharacters(in: .whitespaces).isEmpty
          else { break }
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
        let startIndex = parseOrderedStart(trimmed)
        var items: [String] = []
        while i < lines.count {
          let t = lines[i].trimmingCharacters(in: .whitespaces)
          guard isOrderedItem(t) else { break }
          items.append(stripOrderedMarker(t))
          i += 1
        }
        blocks.append(MarkdownBlock(kind: .orderedList(items, startIndex: startIndex)))
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
    let final =
      String(cleaned).trimmingCharacters(in: .whitespaces).isEmpty
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

  /// Parse the leading number from an ordered list marker (e.g. "3. foo" → 3).
  private static func parseOrderedStart(_ line: String) -> Int {
    var digits = ""
    for ch in line {
      guard ch.isNumber else { break }
      digits.append(ch)
    }
    return Int(digits) ?? 1
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
    return
      trimmed
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
    let inlineFontSize = CGFloat(AppSettings.fontSize)
    for run in attributed.runs {
      // Style links: keep the visible text + a hint color/underline, but the
      // URL stays as inert metadata (no tap-to-open is wired up).
      if attributed[run.range].link != nil {
        attributed[run.range].foregroundColor = .accentColor
        attributed[run.range].underlineStyle = .single
      }
      // Inline `code`: monospaced glyphs on a subtle chip background.
      if run.inlinePresentationIntent?.contains(.code) == true {
        attributed[run.range].font = .system(size: inlineFontSize, design: .monospaced)
        attributed[run.range].backgroundColor = Color.secondary.opacity(0.15)
        attributed[run.range].foregroundColor = Color(nsColor: .systemPink)
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
    VStack(alignment: .leading, spacing: 4) {
      Text(renderInlineMarkdown(raw))
        .font(font)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
      if level <= 2 {
        Divider().opacity(0.6)
      }
    }
    .padding(.top, level <= 2 ? 4 : 0)
  }
}

private struct BlockquoteView: View {
  let raw: String

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      RoundedRectangle(cornerRadius: 2)
        .fill(Color.accentColor.opacity(0.5))
        .frame(width: 3)
      Text(renderInlineMarkdown(raw))
        .font(.body)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(.vertical, 6)
    .padding(.horizontal, 10)
    .background(
      RoundedRectangle(cornerRadius: 6)
        .fill(Color.secondary.opacity(0.06))
    )
  }
}

private struct ListView: View {
  let items: [String]
  let ordered: Bool
  var startIndex: Int = 1

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      ForEach(Array(items.enumerated()), id: \.offset) { index, item in
        HStack(alignment: .top, spacing: 8) {
          Text(ordered ? "\(startIndex + index)." : "•")
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
        ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
          tableRow(row, isHeader: false)
            .background(index.isMultiple(of: 2) ? Color.clear : Color.secondary.opacity(0.04))
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

  @Environment(\.colorScheme) private var colorScheme
  @State private var isHovering = false
  @State private var didCopy = false

  private var theme: CodeTheme {
    colorScheme == .dark ? .dark : .light
  }

  // Honor the user's mono font + size from AppSettings, falling back to the
  // system monospaced face if the configured font isn't installed.
  private var monoFont: Font {
    let size = CGFloat(AppSettings.fontSize)
    let name = AppSettings.monoFontName
    if !name.isEmpty, NSFont(name: name, size: size) != nil {
      return .custom(name, size: size)
    }
    return .system(size: size, design: .monospaced)
  }

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      Text(highlight(code, language: language, theme: theme))
        .font(monoFont)
        .textSelection(.enabled)
        .padding(.horizontal, 14)
        .padding(.top, languageLabel == nil ? 12 : 26)
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .background(
      RoundedRectangle(cornerRadius: 10)
        .fill(theme.background)
    )
    .overlay(
      RoundedRectangle(cornerRadius: 10)
        .stroke(theme.border, lineWidth: 1)
    )
    .overlay(alignment: .topLeading) {
      if let label = languageLabel {
        Text(label)
          .font(.system(size: 10, weight: .medium, design: .monospaced))
          .foregroundStyle(.secondary)
          .padding(.horizontal, 12)
          .padding(.top, 8)
          .opacity(isHovering ? 0.35 : 0.7)
          .animation(.easeInOut(duration: 0.15), value: isHovering)
      }
    }
    .overlay(alignment: .topTrailing) {
      copyButton
        .padding(8)
        .opacity(isHovering || didCopy ? 1 : 0)
        .animation(.easeInOut(duration: 0.15), value: isHovering)
        .animation(.easeInOut(duration: 0.15), value: didCopy)
    }
    .onHover { isHovering = $0 }
  }

  private var languageLabel: String? {
    guard let language, !language.isEmpty else { return nil }
    return language.lowercased()
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

// MARK: - Syntax theme

/// A token-category color palette for fenced code blocks. Two palettes (light /
/// dark) keep the highlight legible on the block's own background. Colors are
/// fixed sRGB values close to a modern editor theme rather than system colors,
/// so they read consistently regardless of accent tint.
struct CodeTheme {
  let background: Color
  let border: Color
  let plain: Color
  let keyword: Color
  let string: Color
  let number: Color
  let comment: Color
  let type: Color
  let function: Color
  let attribute: Color
  let punctuation: Color

  static let light = CodeTheme(
    background: Color(hex: 0xF6F7F9),
    border: Color.secondary.opacity(0.18),
    plain: Color(hex: 0x24292E),
    keyword: Color(hex: 0xCF222E),  // red/pink
    string: Color(hex: 0x0A7D33),  // green
    number: Color(hex: 0xBC5215),  // orange
    comment: Color(hex: 0x6E7781),  // gray
    type: Color(hex: 0x117CA8),  // teal
    function: Color(hex: 0x6639BA),  // purple-blue
    attribute: Color(hex: 0x8250DF),  // violet
    punctuation: Color(hex: 0x57606A)  // slate
  )

  static let dark = CodeTheme(
    background: Color(hex: 0x1E1E22),
    border: Color.white.opacity(0.08),
    plain: Color(hex: 0xD4D4D4),
    keyword: Color(hex: 0xC586C0),  // pink/purple
    string: Color(hex: 0xCE9178),  // peach
    number: Color(hex: 0xD7BA7D),  // soft orange
    comment: Color(hex: 0x6A9955),  // muted green-gray
    type: Color(hex: 0x4EC9B0),  // teal
    function: Color(hex: 0xDCDCAA),  // soft yellow
    attribute: Color(hex: 0x9CDCFE),  // light blue
    punctuation: Color(hex: 0x9D9D9D)  // gray
  )
}

extension Color {
  /// Build an opaque sRGB color from a 0xRRGGBB literal.
  init(hex: UInt32) {
    let r = Double((hex >> 16) & 0xFF) / 255.0
    let g = Double((hex >> 8) & 0xFF) / 255.0
    let b = Double(hex & 0xFF) / 255.0
    self.init(.sRGB, red: r, green: g, blue: b, opacity: 1)
  }
}

// MARK: - Lightweight syntax highlighting

/// A small, dependency-free, regex-based tokenizer. It assigns token categories
/// (keyword, string, number, comment, type, function, attribute, punctuation)
/// for a set of common languages with a generic fallback, then colors them via
/// the supplied `CodeTheme`. Best-effort — no external deps, no remote anything.
func highlight(_ code: String, language: String?, theme: CodeTheme) -> AttributedString {
  var result = AttributedString(code)
  result.foregroundColor = theme.plain

  // Skip highlighting for very large blocks to keep rendering snappy.
  guard code.count <= 20_000 else { return result }

  let spec = LanguageSpec.forLanguage(language)
  let nsString = code as NSString
  let fullRange = NSRange(location: 0, length: nsString.length)

  func apply(_ color: Color, to nsRange: NSRange) {
    guard nsRange.length > 0,
      let range = Range(nsRange, in: code),
      let lo = AttributedString.Index(range.lowerBound, within: result),
      let hi = AttributedString.Index(range.upperBound, within: result)
    else { return }
    result[lo..<hi].foregroundColor = color
  }

  func matches(_ pattern: String, _ options: NSRegularExpression.Options = [])
    -> [NSTextCheckingResult]
  {
    guard let regex = try? NSRegularExpression(pattern: pattern, options: options) else {
      return []
    }
    return regex.matches(in: code, range: fullRange)
  }

  // Order matters: later passes overwrite earlier ones where they overlap. We
  // run low-confidence passes (types, functions, punctuation) first and end
  // with strings then comments, so a `//` inside a string stays a string and
  // a keyword inside a comment is recolored as a comment.

  // 1. Types / title-case identifiers (low priority, easily overridden).
  if spec.highlightTypes {
    for m in matches("\\b[A-Z][A-Za-z0-9_]*\\b") {
      apply(theme.type, to: m.range)
    }
  }

  // 2. Function calls: identifier immediately followed by '('.
  if spec.highlightFunctions {
    for m in matches("\\b[A-Za-z_][A-Za-z0-9_]*\\s*(?=\\()") {
      apply(theme.function, to: m.range)
    }
  }

  // 3. Punctuation / operators.
  for m in matches("[{}()\\[\\];,.:]|[-+*/%=<>!&|^~?]+") {
    apply(theme.punctuation, to: m.range)
  }

  // 4. Attributes / annotations / decorators / variables (@foo, #[..], $var).
  for pattern in spec.attributePatterns {
    for m in matches(pattern) {
      apply(theme.attribute, to: m.range)
    }
  }

  // 5. Keywords (whole-word).
  if !spec.keywords.isEmpty {
    let body = spec.keywords.map { NSRegularExpression.escapedPattern(for: $0) }.joined(
      separator: "|")
    for m in matches("\\b(" + body + ")\\b") {
      apply(theme.keyword, to: m.range)
    }
  }

  // 6. Numbers (int, float with exponent, hex).
  for m in matches("\\b(0[xX][0-9a-fA-F]+|\\d+(\\.\\d+)?([eE][+-]?\\d+)?)\\b") {
    apply(theme.number, to: m.range)
  }

  // 7. Strings.
  for pattern in spec.stringPatterns {
    for m in matches(pattern, [.dotMatchesLineSeparators]) {
      apply(theme.string, to: m.range)
    }
  }

  // 8. Comments (win over everything they cover).
  for pattern in spec.commentPatterns {
    for m in matches(pattern, [.dotMatchesLineSeparators]) {
      apply(theme.comment, to: m.range)
    }
  }

  return result
}

// MARK: - Language specifications

/// Per-language tokenizer configuration: keyword set, which extra passes to run,
/// and the comment/string syntaxes that apply. Regex literals use doubled
/// backslashes for Swift string escaping.
private struct LanguageSpec {
  var keywords: [String]
  var highlightTypes: Bool = true
  var highlightFunctions: Bool = true
  var attributePatterns: [String] = []
  var stringPatterns: [String] = [#""(\\.|[^"\\\n])*""#, #"'(\\.|[^'\\\n])*'"#, "`[^`]*`"]
  var commentPatterns: [String] = ["//[^\\n]*", "/\\*.*?\\*/"]

  static let cComments = ["//[^\\n]*", "/\\*.*?\\*/"]
  static let hashComments = ["#[^\\n]*"]
  static let dqString = #""(\\.|[^"\\\n])*""#
  static let sqString = #"'(\\.|[^'\\\n])*'"#

  static func forLanguage(_ language: String?) -> LanguageSpec {
    switch (language ?? "").lowercased() {
    case "swift":
      return LanguageSpec(
        keywords: [
          "func", "let", "var", "if", "else", "guard", "return", "struct",
          "class", "enum", "protocol", "extension", "import", "for", "while",
          "switch", "case", "default", "do", "try", "catch", "throw", "throws",
          "rethrows", "async", "await", "self", "init", "deinit", "subscript",
          "static", "private", "public", "internal", "fileprivate", "open", "in",
          "where", "nil", "true", "false", "some", "any", "actor", "weak",
          "unowned", "lazy", "final", "override", "convenience", "required",
          "mutating", "nonmutating", "typealias", "associatedtype", "defer",
          "repeat", "break", "continue", "as", "is", "inout", "indirect",
          "willSet", "didSet",
        ],
        attributePatterns: ["@[A-Za-z_][A-Za-z0-9_]*"],
        commentPatterns: cComments)
    case "js", "javascript", "jsx", "mjs", "cjs":
      return LanguageSpec(
        keywords: [
          "function", "const", "let", "var", "if", "else", "return", "class",
          "extends", "super", "import", "export", "from", "as", "for", "while",
          "switch", "case", "default", "do", "try", "catch", "finally", "throw",
          "async", "await", "new", "delete", "this", "null", "undefined", "true",
          "false", "typeof", "instanceof", "void", "in", "of", "yield", "break",
          "continue", "static", "get", "set",
        ],
        attributePatterns: ["@[A-Za-z_][A-Za-z0-9_]*"],
        commentPatterns: cComments)
    case "ts", "typescript", "tsx":
      return LanguageSpec(
        keywords: [
          "function", "const", "let", "var", "if", "else", "return", "class",
          "extends", "implements", "super", "import", "export", "from", "as",
          "for", "while", "switch", "case", "default", "do", "try", "catch",
          "finally", "throw", "async", "await", "new", "delete", "this", "null",
          "undefined", "true", "false", "typeof", "instanceof", "void", "in",
          "of", "yield", "break", "continue", "interface", "type", "enum",
          "namespace", "declare", "public", "private", "protected", "static",
          "readonly", "abstract", "keyof", "infer", "satisfies", "is", "get", "set",
        ],
        attributePatterns: ["@[A-Za-z_][A-Za-z0-9_]*"],
        commentPatterns: cComments)
    case "python", "py":
      return LanguageSpec(
        keywords: [
          "def", "class", "if", "elif", "else", "return", "import", "from",
          "for", "while", "try", "except", "finally", "raise", "with", "as",
          "lambda", "yield", "async", "await", "None", "True", "False", "and",
          "or", "not", "in", "is", "pass", "break", "continue", "global",
          "nonlocal", "assert", "del", "match", "case",
        ],
        attributePatterns: ["@[A-Za-z_][A-Za-z0-9_.]*"],
        stringPatterns: [#""""(.|\n)*?""""#, "'''(.|\\n)*?'''", dqString, sqString],
        commentPatterns: hashComments)
    case "rust", "rs":
      return LanguageSpec(
        keywords: [
          "fn", "let", "mut", "if", "else", "match", "return", "struct",
          "enum", "trait", "impl", "use", "for", "while", "loop", "break",
          "continue", "pub", "mod", "async", "await", "self", "Self", "where",
          "true", "false", "const", "static", "ref", "move", "dyn", "type",
          "crate", "super", "as", "in", "unsafe", "extern", "box",
        ],
        attributePatterns: ["#!?\\[[^\\]]*\\]"],
        commentPatterns: cComments)
    case "go", "golang":
      return LanguageSpec(
        keywords: [
          "func", "var", "const", "if", "else", "return", "struct", "type",
          "interface", "import", "package", "for", "range", "switch", "case",
          "default", "go", "defer", "chan", "map", "nil", "true", "false",
          "break", "continue", "select", "fallthrough", "goto",
        ],
        commentPatterns: cComments)
    case "json", "jsonc":
      return LanguageSpec(
        keywords: ["true", "false", "null"],
        highlightTypes: false,
        highlightFunctions: false,
        stringPatterns: [dqString],
        commentPatterns: cComments)
    case "bash", "sh", "shell", "zsh", "console":
      return LanguageSpec(
        keywords: [
          "if", "then", "else", "elif", "fi", "for", "while", "do", "done",
          "case", "esac", "in", "function", "return", "local", "export",
          "source", "echo", "cd", "exit", "set", "unset", "read", "true",
          "false", "break", "continue",
        ],
        highlightTypes: false,
        attributePatterns: ["\\$\\{?[A-Za-z_][A-Za-z0-9_]*\\}?", "\\$[0-9@*#?]"],
        commentPatterns: hashComments)
    case "html", "xml", "svg", "xhtml":
      return LanguageSpec(
        keywords: [],
        highlightTypes: false,
        highlightFunctions: false,
        attributePatterns: ["</?[A-Za-z][A-Za-z0-9-]*", "/?>", "\\b[A-Za-z-]+(?==)"],
        stringPatterns: [dqString, sqString],
        commentPatterns: ["<!--.*?-->"])
    case "css", "scss", "less":
      return LanguageSpec(
        keywords: [
          "important", "inherit", "initial", "unset", "none", "auto", "hidden",
          "block", "inline", "flex", "grid", "absolute", "relative", "fixed",
        ],
        highlightTypes: false,
        attributePatterns: ["[.#][A-Za-z_][A-Za-z0-9_-]*", "[A-Za-z-]+(?=\\s*:)", "@[A-Za-z-]+"],
        stringPatterns: [dqString, sqString],
        commentPatterns: ["/\\*.*?\\*/"])
    case "sql", "mysql", "postgres", "postgresql", "sqlite":
      return LanguageSpec(
        keywords: [
          "SELECT", "FROM", "WHERE", "INSERT", "INTO", "VALUES", "UPDATE", "SET",
          "DELETE", "CREATE", "TABLE", "DROP", "ALTER", "ADD", "INDEX", "VIEW",
          "JOIN", "INNER", "LEFT", "RIGHT", "OUTER", "FULL", "ON", "AS", "AND",
          "OR", "NOT", "NULL", "IS", "IN", "LIKE", "BETWEEN", "GROUP", "BY",
          "ORDER", "HAVING", "LIMIT", "OFFSET", "DISTINCT", "COUNT", "SUM", "AVG",
          "MIN", "MAX", "PRIMARY", "KEY", "FOREIGN", "REFERENCES", "UNIQUE",
          "DEFAULT", "CASE", "WHEN", "THEN", "ELSE", "END", "UNION", "ALL",
          "EXISTS", "select", "from", "where", "insert", "into", "values",
          "update", "set", "delete", "create", "table", "join", "on", "and",
          "or", "not", "null",
        ],
        highlightTypes: false,
        stringPatterns: [sqString, dqString],
        commentPatterns: ["--[^\\n]*", "/\\*.*?\\*/"])
    default:
      // Generic fallback: a broad keyword set, C-style + hash comments.
      return LanguageSpec(
        keywords: [
          "if", "else", "for", "while", "return", "function", "func", "def",
          "class", "import", "export", "const", "let", "var", "true", "false",
          "null", "nil", "none", "switch", "case", "break", "continue", "try",
          "catch", "throw", "new", "struct", "enum", "type", "public", "private",
        ],
        attributePatterns: ["@[A-Za-z_][A-Za-z0-9_]*"],
        commentPatterns: ["//[^\\n]*", "/\\*.*?\\*/", "#[^\\n]*"])
    }
  }
}
