import SwiftUI

// Renders an extension UI bridge request as a modal overlay and sends the
// response back. Mirrors web/ui-request-dialog.tsx + questionnaire-dialog.tsx.
// Response value shapes match what the backend's web-ui-context expects.
struct UiRequestView: View {
    let request: UiRequest
    var respond: (JSONValue) -> Void

    @State private var inputText = ""
    @State private var selectedQuestionValues: [String: Set<String>] = [:]

    var body: some View {
        ZStack {
            Color.black.opacity(0.4).ignoresSafeArea()
            VStack(alignment: .leading, spacing: 16) {
                Text(request.title).font(.headline)
                if let msg = request.message, !msg.isEmpty {
                    Text(msg).font(.callout).foregroundStyle(.secondary)
                }
                content
            }
            .padding(20)
            .frame(maxWidth: 460)
            .background(.regularMaterial)
            .clipShape(RoundedRectangle(cornerRadius: 18))
            .padding(24)
        }
        .onAppear { inputText = request.answer ?? "" }
    }

    @ViewBuilder private var content: some View {
        switch request.kind {
        case "confirm":
            HStack {
                Button("Cancel", role: .cancel) { respond(.bool(false)) }
                Spacer()
                Button("Confirm") { respond(.bool(true)) }.buttonStyle(.borderedProminent)
            }
        case "select":
            VStack(spacing: 8) {
                ForEach(request.options ?? [], id: \.self) { opt in
                    Button { respond(.string(opt)) } label: {
                        Text(opt).frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.vertical, 10).padding(.horizontal, 12)
                            .background(Color.primary.opacity(0.06))
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                    }
                    .buttonStyle(.plain)
                }
            }
        case "input", "editor", "btw":
            VStack(spacing: 12) {
                TextField(request.placeholder ?? "", text: $inputText, axis: .vertical)
                    .lineLimit(1...8)
                    .textFieldStyle(.roundedBorder)
                HStack {
                    Button("Cancel", role: .cancel) { respond(.null) }
                    Spacer()
                    Button("Send") { respond(.string(inputText)) }.buttonStyle(.borderedProminent)
                }
            }
        case "questionnaire":
            questionnaire
        default:
            Button("Dismiss") { respond(.null) }
        }
    }

    // Questionnaire: answers are returned as an array of { id, values }.
    @ViewBuilder private var questionnaire: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                ForEach(request.questions ?? []) { q in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(q.prompt).font(.subheadline.weight(.medium))
                        ForEach(q.options) { opt in
                            Button { toggle(q, opt.value) } label: {
                                HStack {
                                    Image(systemName: isSelected(q, opt.value)
                                          ? (q.multiSelect ? "checkmark.square.fill" : "largecircle.fill.circle")
                                          : (q.multiSelect ? "square" : "circle"))
                                    VStack(alignment: .leading) {
                                        Text(opt.label)
                                        if let d = opt.description { Text(d).font(.caption2).foregroundStyle(.secondary) }
                                    }
                                    Spacer()
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
        }
        .frame(maxHeight: 360)
        HStack {
            Button("Cancel", role: .cancel) { respond(.null) }
            Spacer()
            Button("Submit") { submitQuestionnaire() }.buttonStyle(.borderedProminent)
        }
    }

    private func isSelected(_ q: UiQuestion, _ value: String) -> Bool {
        selectedQuestionValues[q.id]?.contains(value) ?? false
    }
    private func toggle(_ q: UiQuestion, _ value: String) {
        var set = selectedQuestionValues[q.id] ?? []
        if q.multiSelect {
            if set.contains(value) { set.remove(value) } else { set.insert(value) }
        } else {
            set = [value]
        }
        selectedQuestionValues[q.id] = set
    }
    private func submitQuestionnaire() {
        let answers: [JSONValue] = (request.questions ?? []).map { q in
            let values = Array(selectedQuestionValues[q.id] ?? [])
            return .object([
                "id": .string(q.id),
                "values": .array(values.map { .string($0) }),
            ])
        }
        respond(.array(answers))
    }
}
