import SwiftUI

// The chat screen for one session: scrollback, live streaming, composer, and
// the controls/git/UI-request surfaces. Mirrors web/session-tab.tsx.
struct ChatView: View {
    @StateObject private var vm: SessionViewModel
    let session: SessionInfo
    let cwd: String?

    @State private var input = ""
    @State private var showControls = false
    @State private var showGit = false
    @State private var showCommands = false

    init(api: APIClient, bus: EventBus, session: SessionInfo, cwd: String?) {
        self.session = session
        self.cwd = cwd
        _vm = StateObject(wrappedValue: SessionViewModel(session: session, cwd: cwd, api: api, bus: bus))
    }

    var body: some View {
        VStack(spacing: 0) {
            if !vm.todo.isEmpty { TodoBar(todos: vm.todo) }
            if let goal = vm.goal { GoalBar(goal: goal) }
            messageList
            if let conflict = vm.conflict { conflictBar(conflict) }
            QueueBar(vm: vm)
            if let footer = vm.footer { FooterBar(footer: footer) }
            composer
        }
        .navigationTitle(vm.name ?? session.displayName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                if vm.streaming {
                    Button { Task { await vm.abort() } } label: { Image(systemName: "stop.circle") }
                }
                Button { showGit = true } label: { Image(systemName: "arrow.triangle.branch") }
                Button { showControls = true } label: { Image(systemName: "slider.horizontal.3") }
            }
        }
        .task { await vm.start() }
        .onDisappear { vm.stop() }
        .sheet(isPresented: $showControls) { ControlsSheet(vm: vm) }
        .sheet(isPresented: $showGit) { GitSheet(api: apiFromVM, cwd: cwd ?? session.path) }
        .sheet(isPresented: $showCommands) {
            CommandsSheet(vm: vm) { cmd in input = "/\(cmd.name) "; showCommands = false }
        }
        .overlay { uiRequestOverlay }
    }

    // Pull the api back out for the git sheet (vm holds it privately; expose via env instead in a fuller app).
    private var apiFromVM: APIClient { vm.apiRef }

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    if vm.loading { ProgressView().frame(maxWidth: .infinity).padding() }
                    ForEach(vm.messages) { msg in
                        MessageRow(message: msg).id(msg.id)
                    }
                    if let err = vm.error {
                        Text(err).font(.footnote).foregroundStyle(.red)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.horizontal, 14).padding(.vertical, 12)
            }
            .onChange(of: vm.messages.count) { withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
            .onChange(of: vm.messages.last?.text) { proxy.scrollTo("bottom", anchor: .bottom) }
        }
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            Button { showCommands = true } label: {
                Image(systemName: "command").font(.title3)
            }
            TextField("Message pi…", text: $input, axis: .vertical)
                .lineLimit(1...6)
                .textFieldStyle(.plain)
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(Color.primary.opacity(0.06))
                .clipShape(RoundedRectangle(cornerRadius: 18))
            Button {
                let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty else { return }
                input = ""
                Task { await vm.send(text, deliverAs: vm.streaming ? "followUp" : nil) }
            } label: {
                Image(systemName: "arrow.up.circle.fill").font(.title)
            }
            .disabled(input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(.bar)
    }

    private func conflictBar(_ conflict: LockConflict) -> some View {
        HStack {
            Image(systemName: "lock.fill")
            Text(conflict.kind == "revoked" ? "Lock was revoked" : "Session is locked by another writer")
                .font(.footnote)
            Spacer()
            Button("Take over") { Task { await vm.takeover(resend: nil) } }
                .font(.footnote.weight(.semibold))
        }
        .padding(10)
        .background(Color.orange.opacity(0.15))
    }

    @ViewBuilder private var uiRequestOverlay: some View {
        if let req = vm.uiRequest {
            UiRequestView(request: req) { value in
                Task { await vm.respondUi(id: req.id, value: value) }
            }
        }
    }
}
