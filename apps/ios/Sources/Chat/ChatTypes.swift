import Foundation

// Chat view types mirroring web/use-session.ts ChatMessage and friends.

enum ChatRole: String {
    case user, assistant, tool, system, subagent, bash
}

struct ToolCallView: Identifiable, Equatable {
    let id: String
    var name: String
    var argsText: String
    var status: Status
    var resultText: String?

    enum Status { case running, done, error }
}

struct BashRunView: Equatable {
    var command: String
    var output: String
    var exitCode: Int?
    var cancelled: Bool?
    var truncated: Bool?
    var excludeFromContext: Bool?
    var running: Bool?
}

struct SubagentTurn: Equatable {
    var prompt: String
    var finalOutput: String
    var error: String?
}

struct SubagentRunView: Equatable {
    let runId: String
    var agent: String
    var title: String
    var task: String
    var status: String      // running | done | failed
    var model: String?
    var turns: [SubagentTurn]
    var cost: Double?
}

struct ChatMessage: Identifiable, Equatable {
    var key: String
    var role: ChatRole
    var text: String
    var thinking: String?
    var toolCalls: [ToolCallView]?
    var streaming: Bool = false
    var model: String?
    var time: String?
    var elapsedMs: Double?
    var interrupted: Bool = false
    var errorMessage: String?
    var subagentRun: SubagentRunView?
    var bash: BashRunView?

    var id: String { key }

    static func == (lhs: ChatMessage, rhs: ChatMessage) -> Bool {
        lhs.key == rhs.key &&
        lhs.text == rhs.text &&
        lhs.thinking == rhs.thinking &&
        lhs.streaming == rhs.streaming &&
        lhs.toolCalls == rhs.toolCalls &&
        lhs.interrupted == rhs.interrupted &&
        lhs.errorMessage == rhs.errorMessage &&
        lhs.subagentRun == rhs.subagentRun &&
        lhs.bash == rhs.bash &&
        lhs.elapsedMs == rhs.elapsedMs
    }
}

struct TodoItemView: Identifiable, Equatable {
    let content: String
    let activeForm: String?
    let status: String // pending | in_progress | completed
    var id: String { content }
}

struct GoalStateView: Equatable {
    let objective: String
    let status: String
    let iteration: Int
}

// UI bridge request (confirm/select/input/questionnaire/btw).
struct UiQuestionOption: Identifiable, Equatable {
    let value: String
    let label: String
    let description: String?
    var id: String { value }
}

struct UiQuestion: Identifiable, Equatable {
    let id: String
    let label: String
    let prompt: String
    let options: [UiQuestionOption]
    let multiSelect: Bool
}

struct UiRequest: Equatable {
    let id: String
    let kind: String // select | confirm | input | editor | questionnaire | btw
    let title: String
    var message: String?
    var placeholder: String?
    var options: [String]?
    var questions: [UiQuestion]?
    var answer: String?
}

struct LockConflict: Equatable {
    let kind: String // locked | revoked
    var byLabel: String?
}
