import SwiftUI

// Horizontal tab strip for open sessions. Shows a streaming spinner per live tab, the session
// title + cwd basename, and a close button. Click to activate.
struct TabStripView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 0) {
                ForEach(model.tabs) { tab in
                    TabItem(tab: tab,
                            isActive: tab.id == model.activeTabID,
                            onSelect: { model.activeTabID = tab.id },
                            onClose: { model.closeTab(tab.id) })
                    Divider().frame(height: 22)
                }
            }
        }
        .frame(height: 38)
        .background(.bar)
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
        HStack(spacing: 6) {
            if runtime.isStreaming {
                ProgressView().controlSize(.small).scaleEffect(0.6)
            }
            VStack(alignment: .leading, spacing: 0) {
                Text(runtime.sessionName ?? tab.title)
                    .font(.caption).fontWeight(isActive ? .semibold : .regular)
                    .lineLimit(1)
                Text(Fmt.dirBasename(tab.cwd))
                    .font(.system(size: 9)).foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
            .frame(maxWidth: 150, alignment: .leading)

            Button(action: { if runtime.isStreaming { confirmClose = true } else { onClose() } }) {
                Image(systemName: "xmark")
                    .font(.system(size: 9))
            }
            .buttonStyle(.borderless)
            .opacity(hovering || isActive ? 0.7 : 0)
            .confirmationDialog("This session is still running. Stop it and close the tab?",
                                isPresented: $confirmClose) {
                Button("Stop and close", role: .destructive) { runtime.abort(); onClose() }
                Button("Cancel", role: .cancel) {}
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 5)
        .frame(maxHeight: .infinity)
        .background(isActive ? AnyShapeStyle(.selection.opacity(0.5)) : AnyShapeStyle(.clear))
        .overlay(alignment: .bottom) {
            if isActive { Rectangle().fill(Color.accentColor).frame(height: 2) }
        }
        .contentShape(Rectangle())
        .onTapGesture(perform: onSelect)
        .onHover { hovering = $0 }
    }
}
