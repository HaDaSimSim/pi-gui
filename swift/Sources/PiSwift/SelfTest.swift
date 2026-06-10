import Foundation

// Headless self-test harness (PISWIFT_SELFTEST=1). Validates the load-bearing core against
// real data without launching the UI: jsonl parsing, footer aggregation, lock byte-compat.
enum SelfTest {
    static func run() {
        print("=== PiSwift self-test ===")
        testLock()
        testParser()
        if ProcessInfo.processInfo.environment["PISWIFT_RPC"] == "1" {
            testRpc()
        }
        if ProcessInfo.processInfo.environment["PISWIFT_RESUME"] == "1" {
            testResume()
        }
        print("=== done ===")
    }

    static func testRpc() {
        print("\n[rpc] live round-trip via RuntimeSession")
        let config = PiConfig.discover()
        print("  pi: \(config.piPath)  model: \(config.defaultModelSpec ?? "nil")")
        let sessionDir = NSTemporaryDirectory() + "piswift-rpc-test"
        try? FileManager.default.removeItem(atPath: sessionDir)

        // RuntimeSession is @MainActor; drive it from a main-actor task and pump the runloop.
        let done = DispatchSemaphore(value: 0)
        var sawText = false
        Task { @MainActor in
            let rt = RuntimeSession(cwd: NSTemporaryDirectory(), piPath: config.piPath,
                                    model: config.defaultModelSpec, sessionDir: sessionDir)
            do { try rt.start() } catch { print("  start failed: \(error)"); done.signal(); return }
            // Poll for completion off the published state.
            rt.sendPromptWhenReady("Reply with exactly: PONG") {
                print("  streaming=\(rt.isStreaming) items=\(rt.items.count) model=\(rt.model ?? "nil")")
                for it in rt.items { if case .assistant(_, let am) = it { print("  assistant: \(am.text.prefix(80))"); if am.text.contains("PONG") { sawText = true } } }
                print("  footer cost=\(String(format: "%.4f", rt.footer.cost)) sessionPath=\(rt.sessionPathForTest ?? "nil")")
                rt.dispose()
                done.signal()
            }
        }
        // Pump the main runloop until the async work signals (CLI has no app runloop running).
        let deadline = Date().addingTimeInterval(90)
        while done.wait(timeout: .now()) == .timedOut && Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        }
        print("  sawPONG=\(sawText)")
        print("  OK")
    }

    static func testLock() {
        print("\n[lock] byte-compat + state machine")
        let tmp = NSTemporaryDirectory() + "piswift-selftest-locks"
        try? FileManager.default.removeItem(atPath: tmp)
        let sessionPath = "/tmp/piswift-selftest/fake-session.jsonl"

        let a = SessionLock(sessionPath: sessionPath, owner: "pi-web", label: "pi-gui: test", lockDir: tmp)
        let r1 = a.tryAcquire()
        print("  tryAcquire acquired=\(r1.acquired) isMine=\(a.isMine())")
        assert(r1.acquired && a.isMine(), "should acquire when free")

        // A second holder (different owner) must see it as held, not acquire.
        let b = SessionLock(sessionPath: sessionPath, owner: "pi", label: "TUI", lockDir: tmp)
        let r2 = b.tryAcquire()
        print("  other tryAcquire acquired=\(r2.acquired) current.owner=\(r2.current?.owner ?? "nil")")
        assert(!r2.acquired, "should not acquire when held by live holder")

        // Verify the on-disk record shape matches the TS schema (no extra keys, label present).
        let key = lockFileName(for: sessionPath)
        if let data = FileManager.default.contents(atPath: tmp + "/" + key),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            let keys = Set(obj.keys)
            print("  record keys: \(keys.sorted())")
            assert(keys == ["sessionPath", "owner", "pid", "host", "label", "since", "token"], "record schema mismatch")
            assert(obj["owner"] as? String == "pi-web", "owner must be pi-web")
        } else {
            assert(false, "lock file not written")
        }

        // Takeover by b, then a must see itself as lost.
        b.takeover()
        print("  after b.takeover: a.isMine=\(a.isMine()) a.isLost=\(a.isLost()) b.isMine=\(b.isMine())")
        assert(!a.isMine() && a.isLost() && b.isMine(), "takeover state machine wrong")

        // listLocks sees one live record.
        let live = listLocks(lockDir: tmp)
        print("  listLocks count=\(live.count)")
        assert(live.count == 1, "expected 1 live lock")

        b.release()
        assert(!b.isMine(), "release should clear")
        try? FileManager.default.removeItem(atPath: tmp)
        print("  OK")
    }

    private static func lockFileName(for sessionPath: String) -> String {
        SessionLock.fileName(for: sessionPath)
    }

    /// Resume test: create a session, send a prompt (file A grows), dispose, then resume the
    /// SAME file via a fresh RuntimeSession and prompt again. Verify NO new file is created and
    /// the original file gains the new turn.
    static func testResume() {
        print("\n[resume] open existing session -> resumes (no new file)")
        let config = PiConfig.discover()
        let dir = NSTemporaryDirectory() + "piswift-resume-test"
        try? FileManager.default.removeItem(atPath: dir)

        let done = DispatchSemaphore(value: 0)
        var ok = false
        Task { @MainActor in
            let rt1 = RuntimeSession(cwd: NSTemporaryDirectory(), piPath: config.piPath,
                                     model: config.defaultModelSpec, sessionDir: dir)
            do { try rt1.start() } catch { print("  start1 failed: \(error)"); done.signal(); return }
            rt1.sendPromptWhenReady("Say A") {
                let path = rt1.sessionPathForTest
                rt1.dispose()
                guard let path else { print("  no session path"); done.signal(); return }
                let filesBefore = (try? FileManager.default.contentsOfDirectory(atPath: dir))?.count ?? 0
                print("  created \(path.split(separator: "/").last ?? ""), files=\(filesBefore)")
                // Resume the same file in a new RuntimeSession.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    let rt2 = RuntimeSession(cwd: NSTemporaryDirectory(), piPath: config.piPath,
                                             model: config.defaultModelSpec, sessionDir: nil)
                    rt2.setSessionPathForBrowsing(path)
                    do { try rt2.start() } catch { print("  start2 failed: \(error)"); done.signal(); return }
                    rt2.sendPromptWhenReady("Say B") {
                        let filesAfter = (try? FileManager.default.contentsOfDirectory(atPath: dir))?.count ?? 0
                        let resumedPath = rt2.sessionPathForTest
                        print("  after resume: files=\(filesAfter) resumedPath matches=\(resumedPath == path)")
                        rt2.dispose()
                        ok = (filesAfter == filesBefore) && (resumedPath == path)
                        done.signal()
                    }
                }
            }
        }
        let deadline = Date().addingTimeInterval(120)
        while done.wait(timeout: .now()) == .timedOut && Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        }
        print("  resumedCorrectly=\(ok)")
        print("  OK")
    }

    static func testParser() {
        print("\n[parser] real session files")
        let store = SessionStore()
        let dirs = store.directories()
        print("  directories found: \(dirs.count)")
        guard let first = dirs.first(where: { $0.cwd.contains("pi-gui") }) ?? dirs.first else {
            print("  (no sessions to test)")
            return
        }
        let sessions = store.sessions(forCwd: first.cwd)
        print("  cwd=\(first.cwd) sessions=\(sessions.count)")
        guard let s = sessions.first else { return }
        print("  testing: \(s.id) size=\(s.sizeBytes) name=\(s.name ?? "nil")")

        let sf = SessionFile(path: s.path)
        // Header.
        if let h = try? sf.header() {
            print("  header id=\(h.id) version=\(h.version) cwd=\(h.cwd ?? "nil")")
        } else {
            print("  WARN: header parse failed")
        }
        // Tail parse (OOM-safe).
        let t0 = Date()
        let entries = (try? sf.tailEntries()) ?? []
        let dt = Date().timeIntervalSince(t0)
        print("  tailEntries: \(entries.count) entries in \(String(format: "%.3f", dt))s")
        let items = Transcript.build(from: entries, hideThinking: false)
        print("  transcript items: \(items.count)")
        // Verify turn-meta elapsed attached, todo lists, subagent turns parsed.
        var withElapsed = 0, todoLists = 0, subRuns = 0, subWithTurns = 0
        for it in items {
            switch it {
            case .assistant(_, let am): if am.elapsed != nil { withElapsed += 1 }
            case .todoList(_, let todos): if !todos.isEmpty { todoLists += 1 }
            case .subagentRun(_, let run): subRuns += 1; if !run.turns.isEmpty { subWithTurns += 1 }
            default: break
            }
        }
        print("  assistant msgs with elapsed (turn-meta): \(withElapsed)")
        print("  todo-list items: \(todoLists)")
        print("  subagent runs: \(subRuns) (with full turns: \(subWithTurns))")
        let footer = Transcript.footer(from: entries)
        print("  footer: in=\(footer.inputTokens) out=\(footer.outputTokens) cost=\(String(format: "%.4f", footer.cost)) model=\(footer.model ?? "nil") todos=\(footer.todosDone)/\(footer.todosTotal)")

        // Stress: parse the largest session via tail (must stay fast + bounded memory).
        if let big = sessions.max(by: { $0.sizeBytes < $1.sizeBytes }) {
            let bf = SessionFile(path: big.path)
            let t1 = Date()
            let be = (try? bf.tailEntries()) ?? []
            print("  LARGEST (\(big.sizeBytes / 1024)KB): tail \(be.count) entries in \(String(format: "%.3f", Date().timeIntervalSince(t1)))s")
        }
        print("  OK")
    }
}
