import SwiftUI

// Above-composer widgets: todo list, goal status, and the queued-message bar.
// Mirrors web/todo-widget.tsx + the footer goal status + queue display.

struct TodoBar: View {
    let todos: [TodoItemView]
    @State private var expanded = false

    private var done: Int { todos.filter { $0.status == "completed" }.count }
    private var current: TodoItemView? { todos.first { $0.status == "in_progress" } }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button { withAnimation { expanded.toggle() } } label: {
                HStack(spacing: 8) {
                    Image(systemName: "checklist").font(.caption)
                    Text(current?.activeForm ?? current?.content ?? "Tasks")
                        .font(.caption.weight(.medium)).lineLimit(1)
                    Spacer()
                    Text("\(done)/\(todos.count)").font(.caption2).foregroundStyle(.secondary)
                    Image(systemName: expanded ? "chevron.up" : "chevron.down")
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
            .buttonStyle(.plain)
            if expanded {
                ForEach(todos) { todo in
                    HStack(spacing: 8) {
                        Image(systemName: icon(todo.status))
                            .font(.caption2).foregroundStyle(color(todo.status))
                        Text(todo.content).font(.caption)
                            .strikethrough(todo.status == "completed")
                            .foregroundStyle(todo.status == "completed" ? .secondary : .primary)
                        Spacer()
                    }
                }
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
        .background(Color.primary.opacity(0.04))
    }

    private func icon(_ s: String) -> String {
        switch s { case "completed": return "checkmark.circle.fill"
        case "in_progress": return "circle.dotted"; default: return "circle" }
    }
    private func color(_ s: String) -> Color {
        switch s { case "completed": return .green; case "in_progress": return .indigo; default: return .secondary }
    }
}

struct GoalBar: View {
    let goal: GoalStateView

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "target").font(.caption).foregroundStyle(color)
            Text(goal.objective).font(.caption.weight(.medium)).lineLimit(1)
            Spacer()
            Text(goal.status).font(.caption2.weight(.semibold)).foregroundStyle(color)
            Text("#\(goal.iteration)").font(.caption2).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 14).padding(.vertical, 6)
        .background(color.opacity(0.10))
    }

    private var color: Color {
        switch goal.status {
        case "achieved": return .green
        case "blocked", "budget-limited": return .red
        case "paused": return .orange
        default: return .indigo
        }
    }
}

struct QueueBar: View {
    @ObservedObject var vm: SessionViewModel

    private var all: [String] { vm.queue.steering + vm.queue.followUp }

    var body: some View {
        if !all.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Text("Queued (\(all.count))").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                ForEach(Array(all.enumerated()), id: \.offset) { _, msg in
                    HStack(spacing: 6) {
                        Image(systemName: "clock").font(.caption2)
                        Text(msg).font(.caption).lineLimit(1)
                        Spacer()
                    }
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 6)
            .background(Color.yellow.opacity(0.10))
        }
    }
}

struct FooterBar: View {
    let footer: FooterData

    private func fmtTokens(_ n: Int) -> String {
        if n >= 1000 { return String(format: "%.1fk", Double(n) / 1000) }
        return "\(n)"
    }

    var body: some View {
        HStack(spacing: 12) {
            if let branch = footer.branch {
                Label(branch, systemImage: "arrow.triangle.branch").lineLimit(1)
            }
            if let model = footer.model {
                Text(model.name).lineLimit(1)
            }
            Spacer()
            if let ctx = footer.contextUsage, let pct = ctx.percent {
                Text("\(Int(pct))%").foregroundStyle(pct > 80 ? .orange : .secondary)
            }
            Text(fmtTokens(footer.tokens.total) + " tok")
            if footer.cost > 0 {
                Text(String(format: "$%.3f", footer.cost))
            }
        }
        .font(.caption2)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 14).padding(.vertical, 5)
        .background(.bar)
    }
}
