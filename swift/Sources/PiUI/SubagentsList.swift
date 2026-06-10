import PiCore
import SwiftUI

// Native subagents list for the info panel: runs grouped by batch (one spawn call), each row a
// status dot + title + agent/turns/cost; tap to drill into the full conversation.
struct SubagentsList: View {
  let runs: [SubagentRun]
  @State private var selected: SubagentRun?

  // Group consecutive runs sharing a batchId (fall back to each run as its own group).
  private var batches: [[SubagentRun]] {
    var out: [[SubagentRun]] = []
    for run in runs {
      if let last = out.last, let bid = run.batchId, bid == last.first?.batchId, bid != nil {
        out[out.count - 1].append(run)
      } else {
        out.append([run])
      }
    }
    return out
  }

  var body: some View {
    if runs.isEmpty {
      ContentUnavailableView("No subagent runs yet", systemImage: "person.2")
    } else {
      VStack(alignment: .leading, spacing: 14) {
        ForEach(Array(batches.enumerated()), id: \.offset) { _, batch in
          VStack(alignment: .leading, spacing: 6) {
            if batch.count > 1 {
              let cost = batch.reduce(0) { $0 + $1.cost }
              Text("Batch · \(batch.count) agents · \(Fmt.cost(cost))")
                .font(.caption2).foregroundStyle(.secondary)
            }
            ForEach(batch, id: \.runId) { run in
              SubagentListRow(run: run)
                .contentShape(Rectangle())
                .onTapGesture { selected = run }
            }
          }
        }
      }
      .sheet(
        item: Binding(
          get: { selected.map { RunBox($0) } }, set: { if $0 == nil { selected = nil } })
      ) { box in
        SubagentDetailView(run: box.run)
      }
    }
  }
}

private struct RunBox: Identifiable {
  let run: SubagentRun
  init(_ r: SubagentRun) { self.run = r }
  var id: String { run.runId }
}

private struct SubagentListRow: View {
  let run: SubagentRun
  private var color: Color {
    if run.stale { return Theme.danger }
    switch run.status {
    case "running": return Theme.streaming
    case "failed", "aborted": return Theme.danger
    default: return Theme.success
    }
  }
  var body: some View {
    HStack(alignment: .top, spacing: 8) {
      Circle().fill(color).frame(width: 8, height: 8).padding(.top, 4)
      VStack(alignment: .leading, spacing: 2) {
        Text(run.title).font(.callout).lineLimit(1)
        HStack(spacing: 5) {
          if let a = run.agent {
            Text(a).font(.system(size: 10, design: .monospaced))
              .foregroundStyle(.secondary)
              .padding(.horizontal, 5).padding(.vertical, 1)
              .background(Capsule().fill(.quaternary))
          }
          if run.turns.count > 1 {
            Text("\(run.turns.count) turns").font(.caption2).foregroundStyle(.tertiary)
          }
          if run.cost > 0 { Text(Fmt.cost(run.cost)).font(.caption2).foregroundStyle(.tertiary) }
          Text(run.stale ? "stale" : run.status).font(.caption2).foregroundStyle(
            run.stale ? Theme.danger : Color.secondary)
        }
      }
      Spacer(minLength: 0)
      Image(systemName: "chevron.right").font(.system(size: 10)).foregroundStyle(.tertiary).padding(
        .top, 3)
    }
    .padding(8)
    .background(Color.secondary.opacity(0.05), in: RoundedRectangle(cornerRadius: 8))
    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.12), lineWidth: 1))
  }
}
