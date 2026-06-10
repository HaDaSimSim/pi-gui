import SwiftUI

// Rich multi-question form rendered from the questionnaire tool's args (a TUI feature surfaced
// natively). Single-select uses option cards; free-text questions get a text field. The RPC
// fallback channel only carries one value per question, so multi-select degrades to single.
struct QuestionnaireSheet: View {
    @ObservedObject var runtime: RuntimeSession
    let state: QuestionnaireState

    @State private var selections: [String: String] = [:]   // questionId -> chosen value
    @State private var customText: [String: String] = [:]    // questionId -> free text
    @State private var index = 0

    private var questions: [QField] { state.questions }
    private var isMulti: Bool { questions.count > 1 }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if isMulti {
                        ForEach(Array(questions.enumerated()), id: \.element.id) { i, q in
                            questionBlock(q, number: i + 1)
                        }
                    } else if let q = questions.first {
                        questionBlock(q, number: nil)
                    }
                }
                .padding(20)
            }
            Divider()
            footer
        }
        .frame(minWidth: 460, idealWidth: 540, minHeight: 320, idealHeight: 520)
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "questionmark.bubble").foregroundStyle(Theme.info)
            Text(questions.count == 1 ? "A quick question" : "\(questions.count) questions")
                .font(.headline)
            Spacer()
        }
        .padding(.horizontal, 20).padding(.vertical, 14)
    }

    private func questionBlock(_ q: QField, number: Int?) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                if let number { Text("\(number).").foregroundStyle(.secondary).font(.callout.monospacedDigit()) }
                Text(q.prompt).font(.callout).fontWeight(.medium)
            }
            if q.options.isEmpty {
                TextField("Type your answer…", text: bindingCustom(q.id))
                    .textFieldStyle(.roundedBorder)
                    .disableAutocorrection(true)
                    .onChange(of: customText[q.id] ?? "") { _, v in selections[q.id] = v }
            } else {
                ForEach(q.options) { opt in
                    OptionRow(option: opt, selected: selections[q.id] == opt.value) {
                        selections[q.id] = opt.value
                        customText[q.id] = ""
                    }
                }
                // Free-text alternative.
                TextField("Or type your own…", text: bindingCustom(q.id))
                    .textFieldStyle(.roundedBorder)
                    .disableAutocorrection(true)
                    .onChange(of: customText[q.id] ?? "") { _, v in
                        if !v.isEmpty { selections[q.id] = v }
                    }
            }
        }
    }

    private var footer: some View {
        HStack {
            Button("Cancel", role: .cancel) { runtime.cancelQuestionnaire() }
            Spacer()
            Button("Submit") { submit() }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(!allAnswered)
        }
        .padding(.horizontal, 20).padding(.vertical, 14)
    }

    private var allAnswered: Bool {
        questions.allSatisfy { q in
            let v = selections[q.id] ?? ""
            return !v.isEmpty
        }
    }

    private func bindingCustom(_ id: String) -> Binding<String> {
        Binding(get: { customText[id] ?? "" }, set: { customText[id] = $0 })
    }

    private func submit() {
        // Produce answers in question order: chosen option value, or free text.
        let answers = questions.map { q -> String in
            selections[q.id] ?? customText[q.id] ?? ""
        }
        runtime.submitQuestionnaire(answers)
    }
}

private struct OptionRow: View {
    let option: QOption
    let selected: Bool
    let onTap: () -> Void
    var body: some View {
        Button(action: onTap) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(selected ? Color.accentColor : .secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(option.label).foregroundStyle(.primary)
                    if let d = option.description {
                        Text(d).font(.caption).foregroundStyle(.secondary)
                    }
                }
                Spacer()
            }
            .padding(10)
            .background(selected ? Color.accentColor.opacity(0.12) : Color.clear,
                        in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8)
                .stroke(selected ? Color.accentColor.opacity(0.5) : Color.secondary.opacity(0.2), lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
