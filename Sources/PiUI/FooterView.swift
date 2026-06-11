import PiCore
import SwiftUI

// Footer status bar, mirroring the TUI/web footer lines (cwd/branch/name, goal/todos,
// token+cost+context+model, lock ownership).
struct FooterView: View {
  var runtime: RuntimeSession
  let cwd: String

  var body: some View {
    VStack(alignment: .leading, spacing: 1) {
      // pwd · name
      HStack(spacing: 6) {
        Text(Fmt.tildePath(cwd))
        if let name = runtime.sessionName {
          Text("•")
          Text(name)
        }
        Spacer()
      }
      // goal + todos
      if runtime.footer.todosTotal > 0 || runtime.footer.goalStatus != nil {
        HStack(spacing: 10) {
          if let g = runtime.footer.goalStatus {
            Text("\(Theme.goalEmoji(g)) goal \(g)")
          }
          if runtime.footer.todosTotal > 0 {
            Text("\(runtime.footer.todosDone)/\(runtime.footer.todosTotal) todos")
          }
          Spacer()
        }
      }
      // stats
      HStack(spacing: 8) {
        let f = runtime.footer
        Text(
          "↑\(Fmt.tokens(f.inputTokens)) ↓\(Fmt.tokens(f.outputTokens)) R\(Fmt.tokens(f.cacheRead)) W\(Fmt.tokens(f.cacheWrite)) \(Fmt.cost(f.cost))"
        )
        if f.contextWindow > 0 {
          Text("\(Fmt.tokens(f.contextTokens))/\(Fmt.tokens(f.contextWindow))")
        }
        Spacer()
        Text(runtime.model ?? "")
        Text("• \(runtime.thinkingLevel == "off" ? "thinking off" : runtime.thinkingLevel)")
      }
      .accessibilityElement(children: .combine)
      .accessibilityLabel(
        "Stats: input \(Fmt.tokens(runtime.footer.inputTokens)), output \(Fmt.tokens(runtime.footer.outputTokens)), cost \(Fmt.cost(runtime.footer.cost)), model \(runtime.model ?? "unknown")"
      )
      // ownership
      HStack {
        Text(lockText).foregroundStyle(lockColor)
        Spacer()
      }
    }
    .font(.system(size: 11, design: .monospaced))
    .foregroundStyle(.secondary)
    .padding(.horizontal, 14).padding(.vertical, 6)
    .background(.bar)
    .animation(.easeOut(duration: 0.25), value: runtime.footer.totalTokens)
    .animation(.easeInOut(duration: 0.2), value: runtime.lockStatus)
  }

  private var lockText: String {
    switch runtime.lockStatus {
    case .owned: return "owned"
    case .readOnly: return "read-only (locked elsewhere)"
    case .lost: return "lost (taken over)"
    }
  }
  private var lockColor: Color {
    switch runtime.lockStatus {
    case .owned: return .secondary
    case .readOnly, .lost: return Theme.streaming
    }
  }
}
