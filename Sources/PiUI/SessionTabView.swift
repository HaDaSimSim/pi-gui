import PiCore
import SwiftUI

// One open session: scrollback (committed items + live streaming overlay), composer, footer.
// Extension UI dialogs surface as a sheet (native), notifications as overlay.
struct SessionTabView: View {
  @Bindable var runtime: RuntimeSession
  let cwd: String
  var model: AppModel?

  @State private var draft = ""
  @State private var isAtBottom = true
  @State private var scrolledToID: String?

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
            .accessibilityLabel("Working on response")
          Text(banner).font(.caption).foregroundStyle(.secondary)
          Spacer()
        }
        .padding(.horizontal, 14).padding(.vertical, 6)
        .background(Theme.streaming.opacity(0.15))
        .accessibilityElement(children: .combine)
      }
      ComposerView(runtime: runtime, draft: $draft, appModel: model)
      FooterView(runtime: runtime, cwd: cwd)
    }
    .sheet(item: $runtime.pendingDialog) { dialog in
      DialogView(dialog: dialog, runtime: runtime)
    }
    .sheet(
      isPresented: Binding(
        get: { runtime.questionnaire != nil },
        set: { if !$0 { runtime.cancelQuestionnaire() } }
      )
    ) {
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
    .background(Theme.streaming.opacity(0.18))
    .accessibilityElement(children: .combine)
    .accessibilityLabel(
      runtime.lockStatus == .lost
        ? "Session taken over. Another writer holds this session."
        : "Session locked elsewhere. Another writer holds this session.")
  }

  private var scrollback: some View {
    ScrollViewReader { proxy in
      scrollContent
        .defaultScrollAnchor(.bottom)
        .scrollPosition(id: $scrolledToID)
        .onChange(of: scrolledToID) { _, newID in
          let atEnd = (newID == "__bottom__" || newID == runtime.items.last?.id)
          isAtBottom = atEnd
        }
        .onChange(of: runtime.items.count) { oldCount, newCount in
          handleItemsCountChange(newCount: newCount, proxy: proxy)
        }
        .onChange(of: streamingTick) { oldTick, newTick in
          handleStreamingTick(proxy: proxy)
        }
        .overlay(alignment: .bottomTrailing) {
          scrollToBottomOverlay(proxy: proxy)
        }
    }
  }

  private func handleItemsCountChange(newCount: Int, proxy: ScrollViewProxy) {
    if newCount > 0 && isAtBottom {
      scrollToBottom(proxy)
    }
  }

  private func handleStreamingTick(proxy: ScrollViewProxy) {
    if isAtBottom {
      scrollToBottom(proxy)
    }
  }

  @ViewBuilder
  private func scrollToBottomOverlay(proxy: ScrollViewProxy) -> some View {
    if !isAtBottom && !runtime.items.isEmpty {
      Button {
        scrollToBottom(proxy)
      } label: {
        Image(systemName: "arrow.down")
          .font(.system(size: 14, weight: .medium))
          .frame(width: 32, height: 32)
      }
      .buttonStyle(.plain)
      .modifier(GlassScrollButtonModifier())
      .padding(16)
      .help("Jump to latest")
      .transition(.opacity.animation(.easeInOut(duration: 0.15)))
    }
  }

  private var scrollContent: some View {
    ScrollView {
      HStack(spacing: 0) {
        Spacer(minLength: 0)
        LazyVStack(alignment: .leading, spacing: 18) {
          if runtime.hasEarlierHistory {
            Color.clear.frame(height: 1)
              .onAppear {
                runtime.loadEarlierHistory()
              }
          }
          ForEach(runtime.items) { item in
            TranscriptItemView(item: item, isStreaming: runtime.isStreaming)
              .id(item.id)
              .transition(.opacity.combined(with: .move(edge: .bottom)))
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
  }

  /// Length of the in-progress streamed assistant turn, so text deltas (which don't change
  /// items.count) still trigger autoscroll.
  private var streamingTick: Int {
    guard runtime.isStreaming, case .assistant(_, let am)? = runtime.items.last else { return 0 }
    return am.text.count + (am.thinking?.count ?? 0) + am.toolCalls.count
  }

  private func scrollToBottom(_ proxy: ScrollViewProxy) {
    withAnimation(.easeOut(duration: 0.15)) {
      proxy.scrollTo("__bottom__", anchor: .bottom)
    }
  }

  // MARK: - Message grouping helpers

  /// Determines whether item at `index` is from the "user" sender.
  private func isUserItem(_ item: TranscriptItem) -> Bool {
    if case .user = item { return true }
    return false
  }

  /// Spacing between consecutive messages: 8pt same sender, 16pt different sender.
  private func spacingBefore(index: Int) -> CGFloat {
    let items = runtime.items
    guard index > 0 else { return 0 }
    let prev = items[index - 1]
    let curr = items[index]
    // Notices get uniform spacing
    if case .notice = curr { return 12 }
    if case .notice = prev { return 12 }
    return isUserItem(prev) == isUserItem(curr) ? 8 : 16
  }

  /// Get the timestamp for an item (user has it directly, assistant from its message).
  private func itemTimestamp(at index: Int) -> Date? {
    let item = runtime.items[index]
    switch item {
    case .user(_, _, let ts): return ts
    case .assistant(_, let msg): return msg.timestamp
    default: return nil
    }
  }

  /// Show a relative timestamp when sender changes, or when >5 minutes elapsed since the last
  /// shown timestamp (Messages.app style).
  private func shouldShowTimestamp(at index: Int) -> Bool {
    guard let ts = itemTimestamp(at: index) else { return false }
    // Always show before the very first message
    if index == 0 { return true }
    // Show when sender changes
    let prev = runtime.items[index - 1]
    let curr = runtime.items[index]
    if isUserItem(prev) != isUserItem(curr) {
      // But only if there's a meaningful time gap (>5 min)
      if let prevTs = itemTimestamp(at: index - 1) {
        return ts.timeIntervalSince(prevTs) > 300
      }
      return true
    }
    // Show if >5 minutes since previous item's timestamp
    if let prevTs = itemTimestamp(at: index - 1) {
      return ts.timeIntervalSince(prevTs) > 300
    }
    return false
  }

  @ViewBuilder private var notifications: some View {
    if let last = runtime.notifications.last {
      Text(last.text)
        .font(.caption)
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(notifColor(last.type), in: Capsule())
        .foregroundStyle(Color(nsColor: .alternateSelectedControlTextColor))
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
    switch type {
    case "error": return Theme.danger
    case "warning": return Theme.streaming
    default: return Theme.info
    }
  }
}

// MARK: - Liquid Glass modifier for scroll-to-bottom button (macOS 26+ with fallback)

private struct GlassScrollButtonModifier: ViewModifier {
  func body(content: Content) -> some View {
    if #available(macOS 26, *) {
      content.glassEffect(.regular.interactive(), in: .circle)
    } else {
      content
        .padding(8)
        .background(.regularMaterial, in: Circle())
    }
  }
}
