import SwiftUI

// Lightweight markdown rendering. SwiftUI's AttributedString(markdown:) handles
// inline formatting; we split fenced code blocks out into monospace blocks so
// code renders readably (mirrors the web markdown.tsx intent, simplified).
struct MarkdownText: View {
    let text: String

    var body: some View {
        let blocks = MarkdownText.split(text)
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .code(let code, let lang):
                    CodeBlock(code: code, language: lang)
                case .text(let md):
                    inline(md)
                }
            }
        }
    }

    @ViewBuilder private func inline(_ md: String) -> some View {
        if let attr = try? AttributedString(markdown: md, options: .init(
            interpretedSyntax: .inlineOnlyPreservingWhitespace)) {
            Text(attr).textSelection(.enabled)
        } else {
            Text(md).textSelection(.enabled)
        }
    }

    enum Block { case text(String); case code(String, String?) }

    static func split(_ s: String) -> [Block] {
        var blocks: [Block] = []
        var inCode = false
        var lang: String?
        var buffer: [String] = []
        func flush(asCode: Bool) {
            let joined = buffer.joined(separator: "\n")
            if asCode { blocks.append(.code(joined, lang)) }
            else if !joined.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { blocks.append(.text(joined)) }
            buffer = []
        }
        for line in s.components(separatedBy: "\n") {
            if line.hasPrefix("```") {
                if inCode { flush(asCode: true); inCode = false; lang = nil }
                else { flush(asCode: false); inCode = true; lang = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces).nilIfEmpty }
            } else {
                buffer.append(line)
            }
        }
        flush(asCode: inCode)
        return blocks
    }
}

struct CodeBlock: View {
    let code: String
    var language: String?

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(code)
                .font(.system(.footnote, design: .monospaced))
                .textSelection(.enabled)
                .padding(10)
        }
        .background(Color.primary.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}
