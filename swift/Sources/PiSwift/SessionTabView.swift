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
            if let banner = runtime.activityBanner {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(banner).font(.caption).foregroundStyle(.secondary)
                    Spacer()
                }
                .padding(.horizontal, 14).padding(.vertical, 6)
                .background(Theme.streaming.opacity(0.1))
            }
            ComposerView(runtime: runtime, draft: $draft)
            FooterView(runtime: runtime, cwd: tab.cwd)
        }
        .navigationTitle(tab.title)
        .navigationSubtitle(Fmt.dirBasename(tab.cwd))
        .sheet(item: $runtime.pendingDialog) { dialog in
            DialogView(dialog: dialog, runtime: runtime)
        }
        .sheet(isPresented: Binding(
            get: { runtime.questionnaire != nil },
            set: { if !$0 { runtime.cancelQuestionnaire() } }
        )) {
            if let q = runtime.questionnaire {
                QuestionnaireSheet(runtime: runtime, state: q)
            }
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
                HStack(spacing: 0) {
                    Spacer(minLength: 0)
                    LazyVStack(alignment: .leading, spacing: 18) {
                        if runtime.hasEarlierHistory {
                            Button {
                                runtime.loadEarlierHistory()
                            } label: {
                                Label("Load earlier history", systemImage: "arrow.up.circle")
                                    .font(.caption)
                            }
                            .buttonStyle(.bordered)
                            .frame(maxWidth: .infinity)
                            .padding(.bottom, 4)
                        }
                        ForEach(runtime.items) { item in
                            TranscriptItemView(item: item, isStreaming: runtime.isStreaming)
                                .id(item.id)
                                .transition(.opacity.combined(with: .move(edge: .bottom)))
                        }
                        // Live streaming overlay (uncommitted partial assistant turn).
                        if runtime.isStreaming {
                            ForEach(runtime.liveTools) { lt in
                                LiveToolRow(name: lt.name, args: lt.args, done: lt.done, isError: lt.isError)
                            }
                            StreamingView(thinking: runtime.streamingThinking, text: runtime.streamingText)
                                .id("__streaming__")
                        }
                        Color.clear.frame(height: 1).id("__bottom__")
                    }
                    .frame(maxWidth: 760)
                    .padding(.horizontal, 20).padding(.vertical, 16)
                    .animation(.easeOut(duration: 0.25), value: runtime.items.count)
                    .animation(.easeInOut(duration: 0.2), value: runtime.isStreaming)
                    Spacer(minLength: 0)
                }
            }
            .onChange(of: runtime.items.count) { _, _ in scrollToBottom(proxy) }
            .onChange(of: runtime.streamingText) { _, _ in scrollToBottom(proxy) }
            .onChange(of: runtime.liveTools.count) { _, _ in scrollToBottom(proxy) }
            .onAppear { scrollToBottom(proxy) }
            .overlay(alignment: .bottomTrailing) {
                Button { scrollToBottom(proxy) } label: {
                    Image(systemName: "arrow.down").padding(8)
                        .background(.regularMaterial, in: Circle())
                }
                .buttonStyle(.plain)
                .padding(16)
                .help("Jump to latest")
            }
        }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        withAnimation(.easeOut(duration: 0.15)) {
            proxy.scrollTo("__bottom__", anchor: .bottom)
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
