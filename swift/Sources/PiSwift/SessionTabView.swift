import SwiftUI

// One open session: scrollback (committed items + live streaming overlay), composer, footer.
// Replaces the stub. Extension UI dialogs surface as a sheet (native), notifications as overlay.
struct SessionTabView: View {
    let tab: AppModel.Tab
    @ObservedObject var runtime: RuntimeSession
    @State private var draft = ""

    init(tab: AppModel.Tab) {
        self.tab = tab
        self.runtime = tab.runtime
    }

    var body: some View {
        VStack(spacing: 0) {
            if runtime.lockStatus != .owned {
                lockBanner
            }
            scrollback
            Divider()
            ComposerView(runtime: runtime, draft: $draft)
            FooterView(runtime: runtime, cwd: tab.cwd)
        }
        .navigationTitle(tab.title)
        .navigationSubtitle(Fmt.dirBasename(tab.cwd))
        .sheet(item: $runtime.pendingDialog) { dialog in
            DialogView(dialog: dialog, runtime: runtime)
        }
        .overlay(alignment: .bottom) { notifications }
    }

    private var lockBanner: some View {
        HStack(spacing: 10) {
            Image(systemName: "lock.fill").foregroundStyle(Theme.streaming)
            VStack(alignment: .leading, spacing: 1) {
                Text(runtime.lockStatus == .lost ? "Session taken over" : "Locked elsewhere")
                    .font(.callout).fontWeight(.medium)
                Text("Another writer holds this session. Take over to send messages.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Button("Force takeover") { runtime.takeover() }
                .buttonStyle(.borderedProminent)
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
        .background(Theme.streaming.opacity(0.12))
    }

    private var scrollback: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    ForEach(runtime.items) { item in
                        TranscriptItemView(item: item, isStreaming: runtime.isStreaming)
                            .id(item.id)
                    }
                    // Live streaming overlay (uncommitted partial assistant turn).
                    if runtime.isStreaming {
                        ForEach(runtime.liveTools) { lt in
                            TranscriptItemView(
                                item: .toolCall(id: lt.id, name: lt.name, args: lt.args,
                                                result: lt.done ? "" : nil, isError: lt.isError),
                                isStreaming: true)
                        }
                        StreamingView(thinking: runtime.streamingThinking, text: runtime.streamingText)
                            .id("__streaming__")
                    }
                }
                .padding(.horizontal, 20).padding(.vertical, 16)
                .frame(maxWidth: 900)
                .frame(maxWidth: .infinity)
            }
            .onChange(of: runtime.items.count) { _, _ in scrollToBottom(proxy) }
            .onChange(of: runtime.streamingText) { _, _ in scrollToBottom(proxy) }
            .onChange(of: runtime.liveTools.count) { _, _ in scrollToBottom(proxy) }
            .onAppear { scrollToBottom(proxy) }
        }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        let target = runtime.isStreaming ? "__streaming__" : runtime.items.last?.id
        guard let target else { return }
        withAnimation(.easeOut(duration: 0.15)) {
            proxy.scrollTo(target, anchor: .bottom)
        }
    }

    @ViewBuilder private var notifications: some View {
        if let last = runtime.notifications.last {
            Text(last.text)
                .font(.caption)
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(notifColor(last.type).opacity(0.9), in: Capsule())
                .foregroundStyle(.white)
                .padding(.bottom, 90)
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .id(last.id)
                .task(id: last.id) {
                    try? await Task.sleep(for: .seconds(3))
                    runtime.notifications.removeAll { $0.id == last.id }
                }
        }
    }
    private func notifColor(_ type: String) -> Color {
        switch type { case "error": return Theme.danger; case "warning": return Theme.streaming; default: return Theme.info }
    }
}

private struct StreamingView: View {
    let thinking: String
    let text: String
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if !thinking.isEmpty {
                HStack(spacing: 6) {
                    Image(systemName: "brain")
                    Text(thinking.suffix(80)).lineLimit(1)
                }
                .font(.caption).foregroundStyle(.secondary)
            }
            if !text.isEmpty {
                MarkdownView(text)
            }
            HStack(spacing: 6) {
                ProgressView().controlSize(.small)
                Text("working…").font(.caption2).foregroundStyle(.tertiary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
