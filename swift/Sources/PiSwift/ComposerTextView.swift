import SwiftUI
import AppKit

// IME-safe multiline input. The load-bearing requirement: never send while there is marked
// (composing) text — otherwise Korean/Japanese/Chinese lose the last character. We wrap
// NSTextView and check `hasMarkedText()` before treating Enter as send.
struct ComposerTextView: NSViewRepresentable {
    @Binding var text: String
    var onSubmit: () -> Void
    var onShiftSubmit: (() -> Void)? = nil   // optional alt action (unused; Shift+Enter = newline)

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSTextView.scrollableTextView()
        guard let tv = scroll.documentView as? NSTextView else { return scroll }
        tv.delegate = context.coordinator
        tv.font = .systemFont(ofSize: max(12, CGFloat(AppSettings.fontSize)))
        tv.isRichText = false
        tv.allowsUndo = true
        tv.drawsBackground = false
        tv.textContainerInset = NSSize(width: 4, height: 7)
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = false
        context.coordinator.textView = tv
        return scroll
    }

    func updateNSView(_ nsView: NSScrollView, context: Context) {
        guard let tv = nsView.documentView as? NSTextView else { return }
        if tv.string != text {
            tv.string = text
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, NSTextViewDelegate {
        let parent: ComposerTextView
        weak var textView: NSTextView?
        init(_ parent: ComposerTextView) { self.parent = parent }

        func textDidChange(_ notification: Notification) {
            guard let tv = notification.object as? NSTextView else { return }
            parent.text = tv.string
        }

        func textView(_ textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
            if commandSelector == #selector(NSResponder.insertNewline(_:)) {
                // IME guard: if composing (marked text present), let the system commit it.
                if textView.hasMarkedText() { return false }
                // Shift+Enter -> newline (let default happen); plain Enter -> send.
                let shift = NSApp.currentEvent?.modifierFlags.contains(.shift) ?? false
                if shift { return false }
                parent.onSubmit()
                return true
            }
            return false
        }
    }
}
