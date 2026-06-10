import SwiftUI

// Safari-style tab strip: equal-width tabs that fill the bar, a raised solid fill on the active
// tab, hairline separators between inactive tabs, close (×) on the left revealed on hover/active,
// centered single-line title, and a trailing "+" to start a new session.
struct TabStripView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(model.tabs.enumerated()), id: \.element.id) { idx, tab in
                let active = tab.id == model.activeTabID
                // Hairline separator between two inactive neighbors (Safari hides it next to active).
                if idx > 0 {
                    Divider()
                        .frame(height: 16)
                        .opacity(active || model.tabs[idx - 1].id == model.activeTabID ? 0 : 1)
                }
                TabItem(tab: tab,
                        isActive: active,
                        onSelect: { model.activeTabID = tab.id },
                        onClose: { model.closeTab(tab.id) })
            }
            // New session: only meaningful when at least one tab exists (uses its cwd as default).
            Button {
                if let cwd = model.activeTab?.cwd { model.newSession(cwd: cwd) }
                else { model.pickFolderAndStart() }
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 12, weight: .medium))
                    .frame(width: 34, height: 30)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
        }
        .frame(height: 34)
        .background(Color(nsColor: .windowBackgroundColor))
        .overlay(alignment: .bottom) { Divider() }
    }
}

private struct TabItem: View {
    let tab: AppModel.Tab
    let isActive: Bool
    let onSelect: () -> Void
    let onClose: () -> Void
    @ObservedObject var runtime: RuntimeSession
    @State private var hovering = false
    @State private var confirmClose = false

    init(tab: AppModel.Tab, isActive: Bool, onSelect: @escaping () -> Void, onClose: @escaping () -> Void) {
        self.tab = tab
        self.isActive = isActive
        self.onSelect = onSelect
        self.onClose = onClose
        self.runtime = tab.runtime
    }

    var body: some View {
        ZStack {
            // Centered title (Safari centers the label regardless of the close button).
            HStack(spacing: 5) {
                if runtime.isStreaming {
                    ProgressView().controlSize(.small).scaleEffect(0.55)
                        .frame(width: 10)
                }
                Text(runtime.sessionName ?? tab.title)
                    .font(.system(size: 12))
                    .fontWeight(isActive ? .medium : .regular)
                    .foregroundStyle(isActive ? .primary : .secondary)
                    .lineLimit(1)
            }
            .padding(.horizontal, 24)

            // Close button pinned left, shown on hover or when active.
            HStack {
                Button(action: { if runtime.isStreaming { confirmClose = true } else { onClose() } }) {
                    Image(systemName: "xmark")
                        .font(.system(size: 9, weight: .semibold))
                        .frame(width: 16, height: 16)
                        .background(hovering ? Color.secondary.opacity(0.2) : .clear, in: Circle())
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .opacity(hovering ? 1 : 0)
                .confirmationDialog("This session is still running. Stop it and close the tab?",
                                    isPresented: $confirmClose) {
                    Button("Stop and close", role: .destructive) { runtime.abort(); onClose() }
                    Button("Cancel", role: .cancel) {}
                }
                Spacer()
            }
            .padding(.leading, 6)
        }
        .frame(maxWidth: 220)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(
            // Active tab: raised solid fill matching the content area below it.
            isActive ? AnyShapeStyle(Color(nsColor: .controlBackgroundColor))
                     : (hovering ? AnyShapeStyle(Color.secondary.opacity(0.08)) : AnyShapeStyle(.clear))
        )
        .contentShape(Rectangle())
        .onTapGesture(perform: onSelect)
        .onHover { hovering = $0 }
    }
}
