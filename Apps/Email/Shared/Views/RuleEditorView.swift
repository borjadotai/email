import SwiftUI

struct RuleEditorContext: Identifiable {
  var id: String
  var rule: MailRule?
  var suggestedName: String?
  var suggestedPrompt: String?

  static var create: RuleEditorContext {
    RuleEditorContext(id: "create-\(UUID().uuidString)", rule: nil)
  }

  static func edit(_ rule: MailRule) -> RuleEditorContext {
    RuleEditorContext(id: "edit-\(rule.id)", rule: rule)
  }

  static func autoArchiveLike(_ email: EmailDetail) -> RuleEditorContext {
    let sender = email.senderName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      ? email.senderEmail
      : email.senderName
    let name = "Archive \(sender)"
    let prompt = autoArchivePrompt(for: email)
    return RuleEditorContext(
      id: "like-\(email.id)-\(UUID().uuidString)",
      rule: nil,
      suggestedName: name,
      suggestedPrompt: prompt
    )
  }
}

struct RuleEditorDraft {
  var name: String
  var action: String
  var enabled: Bool
  var naturalLanguage: String
}

struct RuleEditorSheet: View {
  @Environment(\.dismiss) private var dismiss
  var context: RuleEditorContext
  var onSave: (RuleEditorDraft) -> Void

  @State private var name: String
  @State private var action: String
  @State private var enabled: Bool
  @State private var naturalLanguage: String
  @FocusState private var focusedField: Field?

  private enum Field {
    case name
    case prompt
  }

  init(context: RuleEditorContext, onSave: @escaping (RuleEditorDraft) -> Void) {
    self.context = context
    self.onSave = onSave
    let rule = context.rule
    _name = State(initialValue: rule?.name ?? context.suggestedName ?? "")
    _action = State(initialValue: rule?.action ?? "archive")
    _enabled = State(initialValue: rule?.enabled ?? true)
    _naturalLanguage = State(initialValue: rule?.naturalLanguage ?? context.suggestedPrompt ?? "")
  }

  var body: some View {
    VStack(spacing: 0) {
      header
      Divider()
      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          nameField
          actionPicker
          matchEditor
        }
        .padding(20)
      }
      Divider()
      footer
    }
    #if os(macOS)
    .frame(width: 620, height: 520)
    #endif
    #if os(iOS)
    .presentationDetents([.large])
    #endif
    .task {
      focusedField = trimmedName.isEmpty ? .name : .prompt
    }
  }

  private var header: some View {
    HStack(spacing: 12) {
      Image(systemName: "bolt.circle")
        .font(.title3.weight(.semibold))
        .foregroundStyle(.indigo)

      Text(context.rule == nil ? "New Rule" : "Edit Rule")
        .font(.title2.weight(.semibold))

      Spacer()

      Toggle("Enabled", isOn: $enabled)
        .toggleStyle(.switch)
        .labelsHidden()

      Button {
        dismiss()
      } label: {
        Image(systemName: "xmark")
      }
      .buttonStyle(.borderless)
      .help("Close")
    }
    .padding(.horizontal, 20)
    .padding(.vertical, 16)
  }

  private var nameField: some View {
    VStack(alignment: .leading, spacing: 7) {
      Text("Name")
        .font(.headline)
      TextField("App updates", text: $name)
        .focused($focusedField, equals: .name)
        .textFieldStyle(.roundedBorder)
    }
  }

  private var actionPicker: some View {
    VStack(alignment: .leading, spacing: 7) {
      Text("Action")
        .font(.headline)
      Picker("Action", selection: $action) {
        Label("Auto-archive", systemImage: "archivebox")
          .tag("archive")
      }
      .pickerStyle(.segmented)
    }
  }

  private var matchEditor: some View {
    VStack(alignment: .leading, spacing: 7) {
      Text("Match")
        .font(.headline)
      ZStack(alignment: .topLeading) {
        TextEditor(text: $naturalLanguage)
          .focused($focusedField, equals: .prompt)
          .font(.body)
          .scrollContentBackground(.hidden)
          .padding(.horizontal, 12)
          .padding(.vertical, 10)
          .frame(minHeight: 210)

        if trimmedNaturalLanguage.isEmpty {
          Text("App Store Connect TestFlight build updates")
            .foregroundStyle(.tertiary)
            .padding(.horizontal, 18)
            .padding(.vertical, 18)
            .allowsHitTesting(false)
        }
      }
      .background(sheetCardBackground)
      .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .strokeBorder(Color.primary.opacity(0.10))
      )
    }
  }

  private var footer: some View {
    HStack {
      if let rule = context.rule, let appliedCount = rule.appliedCount, appliedCount > 0 {
        Label("\(appliedCount)", systemImage: "archivebox")
          .font(.caption.weight(.semibold))
          .foregroundStyle(.secondary)
      }

      Spacer()

      Button("Cancel") {
        dismiss()
      }

      Button(context.rule == nil ? "Create" : "Save") {
        onSave(draft)
        dismiss()
      }
      .keyboardShortcut(.defaultAction)
      .disabled(!canSave)
    }
    .padding(.horizontal, 20)
    .padding(.vertical, 14)
  }

  private var draft: RuleEditorDraft {
    RuleEditorDraft(
      name: trimmedName,
      action: action,
      enabled: enabled,
      naturalLanguage: trimmedNaturalLanguage
    )
  }

  private var canSave: Bool {
    !trimmedName.isEmpty && !trimmedNaturalLanguage.isEmpty
  }

  private var trimmedName: String {
    name.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private var trimmedNaturalLanguage: String {
    naturalLanguage.trimmingCharacters(in: .whitespacesAndNewlines)
  }
}

private func autoArchivePrompt(for email: EmailDetail) -> String {
  let subject = email.subject.trimmingCharacters(in: .whitespacesAndNewlines)
  let snippet = email.snippet.trimmingCharacters(in: .whitespacesAndNewlines)
  let sender = "\(email.senderName) <\(email.senderEmail)>"
  let senderLower = sender.lowercased()
  let subjectLower = subject.lowercased()
  let snippetLower = snippet.lowercased()

  if senderLower.contains("app store connect")
    || subjectLower.contains("testflight")
    || snippetLower.contains("testflight")
    || subjectLower.contains("app store connect")
    || snippetLower.contains("app store connect") {
    return "App Store Connect TestFlight build and app update notifications from \(sender) with subjects or snippets like \"\(subject)\" \(snippetExcerpt(snippet))."
  }

  return "Emails from \(sender) with subjects or snippets like \"\(subject)\" \(snippetExcerpt(snippet))."
}

private func snippetExcerpt(_ snippet: String) -> String {
  let trimmed = snippet.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmed.isEmpty else { return "" }
  return "and \"\(String(trimmed.prefix(180)))\""
}

private var sheetCardBackground: Color {
  #if os(macOS)
  Color(nsColor: .controlBackgroundColor)
  #else
  Color(.secondarySystemBackground)
  #endif
}
