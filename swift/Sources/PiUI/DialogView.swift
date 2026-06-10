import PiCore
import SwiftUI

// Native rendering of extension UI dialog requests (select/confirm/input/editor).
// questionnaire/btw arrive as select/input fallbacks under PI_WEB_HOST, so the four
// primitives cover everything (confirmed by PoC 2/3).
struct DialogView: View {
  let dialog: PendingDialog
  @ObservedObject var runtime: RuntimeSession
  @State private var inputText = ""

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      if !dialog.title.isEmpty {
        Text(dialog.title).font(.headline)
      }
      if let msg = dialog.message {
        Text(msg).foregroundStyle(.secondary)
      }

      switch dialog.method {
      case "confirm":
        buttons {
          Button("No") { runtime.answerDialog(dialog, value: nil, confirmed: false) }
          Button("Yes") { runtime.answerDialog(dialog, value: nil, confirmed: true) }
            .keyboardShortcut(.defaultAction)
        }
      case "select":
        VStack(spacing: 6) {
          ForEach(dialog.options, id: \.self) { opt in
            Button {
              runtime.answerDialog(dialog, value: opt, confirmed: nil)
            } label: {
              Text(opt).frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.bordered)
          }
        }
        cancelOnly
      case "input":
        TextField(dialog.placeholder ?? "", text: $inputText)
          .textFieldStyle(.roundedBorder)
          .disableAutocorrection(true)
          .onSubmit { runtime.answerDialog(dialog, value: inputText, confirmed: nil) }
        buttons {
          Button("Cancel") { runtime.answerDialog(dialog, value: nil, confirmed: nil) }
          Button("OK") { runtime.answerDialog(dialog, value: inputText, confirmed: nil) }
            .keyboardShortcut(.defaultAction)
        }
      case "editor":
        TextEditor(text: $inputText)
          .font(.system(.body, design: .monospaced))
          .disableAutocorrection(true)
          .frame(minHeight: 120)
          .border(.quaternary)
          .onAppear { if inputText.isEmpty { inputText = dialog.prefill ?? "" } }
        buttons {
          Button("Cancel") { runtime.answerDialog(dialog, value: nil, confirmed: nil) }
          Button("OK") { runtime.answerDialog(dialog, value: inputText, confirmed: nil) }
            .keyboardShortcut(.defaultAction)
        }
      default:
        Text("Unsupported dialog: \(dialog.method)")
        cancelOnly
      }
    }
    .padding(20)
    .frame(minWidth: 380, maxWidth: 520)
    .onAppear { if dialog.method == "editor" { inputText = dialog.prefill ?? "" } }
  }

  private func buttons<C: View>(@ViewBuilder _ content: () -> C) -> some View {
    HStack {
      Spacer()
      content()
    }
  }
  private var cancelOnly: some View {
    HStack {
      Spacer()
      Button("Cancel") { runtime.answerDialog(dialog, value: nil, confirmed: nil) }
    }
  }
}
