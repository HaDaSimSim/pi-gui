import SwiftUI

// Modern Safari-style tabs: rounded "pill" tabs with small gaps inside a contained tab bar, the
// active tab elevated with a solid fill + soft shadow, inactive tabs flat (hover = faint fill),
// close (×) on the left revealed on hover, centered title, trailing "+".
struct TabStripView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        HStack(spacing: 6) {
            ForEach(model.tabs) { tab in
                TabPill(tab: tab,
                        isActive: tab.id == model.activeTabID,
                        onSelect: { model.activeTabID = tab.id },
                        onClose: { model.closeTab(tab.id) })
            }
            Button {
                if let cwd = model.activeTab?.cwd { model.newSession(cwd: cwd) }
                else { model.pickFolderAndStart() }
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 12, weight: .medium))
                    .frame(width: 28, height: 28)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(.bar)
        .overlay(alignment: .bottom) { Divider() }
        .animation(.easeInOut(duration: 0.2), value: model.tabs.count)
        .animation(.easeInOut(duration: 0.15), value: model.activeTabID)
    }
}

private struct TabPill: View {
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
            HStack(spacing: 5) {
                if runtime.isStreaming {
                    ProgressView().controlSize(.small).scaleEffect(0.5).frame(width: 10)
                }
                Text(runtime.sessionName ?? tab.title)
                    .font(.system(size: 12))
                    .fontWeight(isActive ? .medium : .regular)
                    .foregroundStyle(isActive ? .primary : .secondary)
                    .lineLimit(1)
            }
            .padding(.horizontal, 22)

            HStack {
                Button(action: { if runtime.isStreaming { confirmClose = true } else { onClose() } }) {
                    Image(systemName: "xmark")
                        .font(.system(size: 8, weight: .bold))
                        .frame(width: 15, height: 15)
                        .background(hovering ? Color.secondary.opacity(0.25) : .clear, in: Circle())
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
            .padding(.leading, 5)
        }
        .frame(height: 26)
        .frame(maxWidth: .infinity)
        .background(
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(isActive ? AnyShapeStyle(Color(nsColor: .controlBackgroundColor))
                               : (hovering ? AnyShapeStyle(Color.secondary.opacity(0.12)) : AnyShapeStyle(Color.clear)))
                .shadow(color: isActive ? Color.black.opacity(0.18) : .clear, radius: 1.5, y: 0.5)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .stroke(isActive ? Color.black.opacity(0.08) : .clear, lineWidth: 0.5)
        )
        .contentShape(Rectangle())
        .onTapGesture(perform: onSelect)
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.12), value: isActive)
    }
}
