import SwiftUI

struct SidebarView: View {
  @Environment(AppModel.self) private var model
  @State private var filterEditor: FilterEditorContext?
  var onAddAccount: () -> Void
  var onShowMessages: () -> Void

  var body: some View {
    let visibleMailboxes = scopedMailboxes
    let visibleLabels = scopedLabels

    List {
      Section {
        SidebarButton(
          title: "All Inboxes",
          subtitle: "Global",
          systemImage: "tray.full",
          count: model.globalUnreadCount,
          isSelected: model.selectedAccountID == nil
            && model.selectedMailboxID == nil
            && model.selectedLabelID == nil
            && model.selectedFilterID == nil
        ) {
          onShowMessages()
          Task {
            await model.selectGlobalInbox()
          }
        }
      }

      if !model.accounts.isEmpty {
        Section("Accounts") {
          ForEach(model.accounts) { account in
            SidebarButton(
              title: account.displayName,
              subtitle: account.email,
              systemImage: account.provider.systemImage,
              avatarName: account.displayName,
              avatarEmail: account.email,
              avatarURL: account.avatarURL,
              count: unreadCount(for: account),
              isSelected: model.selectedAccountID == account.id
                && model.selectedMailboxID == nil
                && model.selectedLabelID == nil
                && model.selectedFilterID == nil
            ) {
              onShowMessages()
              Task {
                await model.selectAccount(account)
              }
            }
          }
        }
      }

      if activeSidebarAccountID == nil {
        Section("Filters") {
          ForEach(model.filters) { filter in
            SidebarButton(
              title: filter.name,
              subtitle: "Saved view",
              systemImage: filter.systemImage,
              tint: filter.swiftUIColor,
              isSelected: model.selectedFilterID == filter.id
            ) {
              onShowMessages()
              Task {
                await model.selectFilter(filter)
              }
            }
            .contextMenu {
              Button("Edit Filter") {
                filterEditor = .edit(filter)
              }
            }
          }

          SidebarButton(
            title: "New Filter",
            subtitle: nil,
            systemImage: "plus.circle",
            tint: .secondary,
            isSelected: false
          ) {
            filterEditor = .create
          }
        }
      }

      if !visibleMailboxes.isEmpty {
        Section("Folders") {
          ForEach(visibleMailboxes) { mailbox in
            SidebarButton(
              title: mailbox.name,
              subtitle: nil,
              systemImage: image(for: mailbox.role),
              count: mailbox.unreadCount,
              isSelected: model.selectedMailboxID == mailbox.id
            ) {
              onShowMessages()
              Task {
                await model.selectMailbox(mailbox)
              }
            }
          }
        }
      }

      if !visibleLabels.isEmpty {
        Section("Labels") {
          ForEach(visibleLabels) { label in
            SidebarButton(
              title: label.name,
              subtitle: nil,
              systemImage: "tag",
              tint: label.swiftUIColor,
              isSelected: model.selectedLabelID == label.id
            ) {
              onShowMessages()
              Task {
                await model.selectLabel(label)
              }
            }
          }
        }
      }
    }
    .listStyle(.sidebar)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .clipped()
    .navigationTitle("Email")
    .toolbar {
      ToolbarItem {
        Button(action: onAddAccount) {
          Image(systemName: "plus")
        }
        .help("Add account")
      }
    }
    .sheet(item: $filterEditor) { context in
      FilterEditorSheet(context: context) { draft in
        Task {
          if let filter = context.filter {
            await model.updateFilter(
              filter,
              name: draft.name,
              color: draft.color,
              icon: draft.icon,
              naturalLanguage: draft.naturalLanguage,
              criteria: draft.criteria
            )
          } else {
            await model.createFilter(
              name: draft.name,
              color: draft.color,
              icon: draft.icon,
              naturalLanguage: draft.naturalLanguage,
              criteria: draft.criteria
            )
          }
        }
      }
    }
  }

  private func unreadCount(for account: MailAccount) -> Int {
    model.mailboxes
      .filter { $0.accountId == account.id && $0.role == "inbox" }
      .reduce(0) { $0 + $1.unreadCount }
  }

  private var activeSidebarAccountID: String? {
    if let selectedAccountID = model.selectedAccountID {
      return selectedAccountID
    }

    if let selectedMailboxID = model.selectedMailboxID {
      return model.mailboxes.first(where: { $0.id == selectedMailboxID })?.accountId
    }

    if let selectedLabelID = model.selectedLabelID {
      return model.labels.first(where: { $0.id == selectedLabelID })?.accountId
    }

    return nil
  }

  private var scopedMailboxes: [Mailbox] {
    guard let accountID = activeSidebarAccountID else { return [] }
    return model.mailboxes.filter { $0.accountId == accountID }
  }

  private var scopedLabels: [MailLabel] {
    if let accountID = activeSidebarAccountID {
      return model.labels.filter { $0.accountId == accountID }
    }

    return []
  }

  private func image(for role: String) -> String {
    switch role {
    case "inbox": "tray"
    case "sent": "paperplane"
    case "drafts": "doc"
    case "archive": "archivebox"
    case "spam": "exclamationmark.octagon"
    case "trash": "trash"
    default: "folder"
    }
  }
}

private struct FilterEditorContext: Identifiable {
  var id: String
  var filter: MailFilter?

  static var create: FilterEditorContext {
    FilterEditorContext(id: "create-\(UUID().uuidString)", filter: nil)
  }

  static func edit(_ filter: MailFilter) -> FilterEditorContext {
    FilterEditorContext(id: "edit-\(filter.id)", filter: filter)
  }
}

private struct FilterEditorDraft {
  var name: String
  var color: String
  var icon: String
  var naturalLanguage: String?
  var criteria: MailFilterCriteria
}

private enum FilterEditorMode: Equatable {
  case choose
  case naturalLanguage
  case manual
}

private struct FilterEditorSheet: View {
  @Environment(\.dismiss) private var dismiss
  var context: FilterEditorContext
  var onSave: (FilterEditorDraft) -> Void

  @State private var mode: FilterEditorMode
  @State private var name: String
  @State private var color: String
  @State private var icon: String
  @State private var naturalLanguage: String
  @State private var sender: String
  @State private var subject: String
  @State private var text: String
  @State private var hasAttachments: Bool
  @State private var attachmentKind: String
  @State private var unreadOnly: Bool
  @State private var starredOnly: Bool
  @FocusState private var promptFocused: Bool

  init(context: FilterEditorContext, onSave: @escaping (FilterEditorDraft) -> Void) {
    self.context = context
    self.onSave = onSave
    let filter = context.filter
    let criteria = filter?.criteria ?? MailFilterCriteria()
    _mode = State(initialValue: filter == nil ? .choose : (filter?.naturalLanguage?.isEmpty == false ? .naturalLanguage : .manual))
    _name = State(initialValue: filter?.name ?? "")
    _color = State(initialValue: filter?.color ?? FilterEditorOption.colors.first?.id ?? "teal")
    _icon = State(initialValue: filter?.systemImage ?? FilterEditorOption.icons.first?.id ?? "line.3.horizontal.decrease.circle")
    _naturalLanguage = State(initialValue: filter?.naturalLanguage ?? "")
    _sender = State(initialValue: criteria.sender ?? "")
    _subject = State(initialValue: criteria.subject ?? "")
    _text = State(initialValue: criteria.text ?? criteria.query ?? "")
    _hasAttachments = State(initialValue: criteria.hasAttachments ?? (criteria.attachmentKind != nil))
    _attachmentKind = State(initialValue: criteria.attachmentKind ?? "none")
    _unreadOnly = State(initialValue: criteria.unread ?? false)
    _starredOnly = State(initialValue: criteria.starred ?? false)
  }

  var body: some View {
    VStack(spacing: 0) {
      header
      Divider()
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          switch mode {
          case .choose:
            modeChooser
          case .naturalLanguage:
            naturalLanguageBuilder
          case .manual:
            manualBuilder
          }
        }
        .padding(20)
      }
      Divider()
      footer
    }
    #if os(macOS)
    .frame(width: 640, height: 560)
    #endif
    #if os(iOS)
    .presentationDetents([.large])
    #endif
  }

  private var header: some View {
    HStack(spacing: 12) {
      if mode != .choose && context.filter == nil {
        Button {
          mode = .choose
        } label: {
          Image(systemName: "chevron.left")
        }
        .buttonStyle(.borderless)
        .help("Back")
      }

      Text(context.filter == nil ? "New Filter" : "Edit Filter")
        .font(.title2.weight(.semibold))

      Spacer()

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

  private var modeChooser: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("Create a saved mail view")
        .font(.headline)
      HStack(spacing: 12) {
        FilterModeCard(
          title: "Natural language",
          subtitle: "Describe the messages this filter should collect.",
          systemImage: "sparkles",
          tint: .teal
        ) {
          mode = .naturalLanguage
          promptFocused = true
        }

        FilterModeCard(
          title: "Manual",
          subtitle: "Choose sender, text, status, and attachment rules.",
          systemImage: "slider.horizontal.3",
          tint: .blue
        ) {
          mode = .manual
        }
      }
    }
  }

  private var naturalLanguageBuilder: some View {
    VStack(alignment: .leading, spacing: 16) {
      FilterAppearanceSection(name: $name, color: $color, icon: $icon)

      VStack(alignment: .leading, spacing: 10) {
        Text("Description")
          .font(.headline)

        ZStack(alignment: .topLeading) {
          TextEditor(text: $naturalLanguage)
            .focused($promptFocused)
            .font(.body)
            .scrollContentBackground(.hidden)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(minHeight: 180)
            .onChange(of: naturalLanguage) { _, value in
              applyNaturalLanguageDefaults(value)
            }

          if naturalLanguage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            Text("Find emails with invoice attachments from any sender")
              .foregroundStyle(.tertiary)
              .padding(.horizontal, 18)
              .padding(.vertical, 18)
              .allowsHitTesting(false)
          }

          VStack {
            HStack {
              Spacer()
              Button {
                promptFocused = true
              } label: {
                Image(systemName: "mic")
              }
              .buttonStyle(.borderless)
              .padding(12)
              .help("Dictate")
            }
            Spacer()
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
  }

  private var manualBuilder: some View {
    VStack(alignment: .leading, spacing: 16) {
      FilterAppearanceSection(name: $name, color: $color, icon: $icon)

      VStack(alignment: .leading, spacing: 12) {
        Text("Conditions")
          .font(.headline)

        FilterTextField(title: "Sender contains", systemImage: "person.crop.circle", text: $sender)
        FilterTextField(title: "Subject contains", systemImage: "textformat", text: $subject)
        FilterTextField(title: "Text contains", systemImage: "magnifyingglass", text: $text)

        Divider()

        Toggle(isOn: $hasAttachments) {
          Label("Has attachments", systemImage: "paperclip")
        }

        Picker("Attachment type", selection: $attachmentKind) {
          Text("Any").tag("none")
          Text("Invoice or receipt").tag("invoice")
          Text("PDF").tag("pdf")
          Text("Image").tag("image")
          Text("Spreadsheet").tag("spreadsheet")
          Text("Document").tag("document")
        }
        .pickerStyle(.menu)

        Divider()

        Toggle(isOn: $unreadOnly) {
          Label("Unread only", systemImage: "envelope.badge")
        }
        Toggle(isOn: $starredOnly) {
          Label("Starred only", systemImage: "star")
        }
      }
      .padding(14)
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
      Spacer()
      Button("Cancel") {
        dismiss()
      }
      Button("Save") {
        onSave(draft)
        dismiss()
      }
      .keyboardShortcut(.defaultAction)
      .disabled(!canSave)
    }
    .padding(.horizontal, 20)
    .padding(.vertical, 14)
  }

  private var draft: FilterEditorDraft {
    switch mode {
    case .naturalLanguage:
      FilterEditorDraft(
        name: trimmedName,
        color: color,
        icon: icon,
        naturalLanguage: trimmedNaturalLanguage,
        criteria: MailFilterCriteria()
      )
    case .manual:
      FilterEditorDraft(
        name: trimmedName,
        color: color,
        icon: icon,
        naturalLanguage: nil,
        criteria: manualCriteria
      )
    case .choose:
      FilterEditorDraft(name: "", color: color, icon: icon, naturalLanguage: nil, criteria: MailFilterCriteria())
    }
  }

  private var manualCriteria: MailFilterCriteria {
    MailFilterCriteria(
      sender: sender.trimmedOrNil,
      subject: subject.trimmedOrNil,
      text: text.trimmedOrNil,
      query: nil,
      hasAttachments: hasAttachments || attachmentKind != "none" ? true : nil,
      attachmentKind: attachmentKind == "none" ? nil : attachmentKind,
      unread: unreadOnly ? true : nil,
      starred: starredOnly ? true : nil
    )
  }

  private var canSave: Bool {
    switch mode {
    case .choose:
      false
    case .naturalLanguage:
      !trimmedNaturalLanguage.isEmpty
    case .manual:
      !trimmedName.isEmpty
    }
  }

  private var trimmedName: String {
    name.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private var trimmedNaturalLanguage: String {
    naturalLanguage.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private func applyNaturalLanguageDefaults(_ value: String) {
    let lower = value.lowercased()
    guard !lower.isEmpty else { return }

    if lower.range(of: #"\b(invoice|factura|receipt|recibo|bill|billing)\b"#, options: .regularExpression) != nil {
      applySuggestedPresentation(name: "Invoices", color: "green", icon: "doc.text")
    } else if lower.contains("attachment") || lower.contains("attached") || lower.contains("pdf") {
      applySuggestedPresentation(name: "Attachments", color: "teal", icon: "paperclip")
    } else if lower.contains("unread") {
      applySuggestedPresentation(name: "Unread", color: "blue", icon: "envelope.badge")
    } else if lower.contains("starred") || lower.contains("favorite") || lower.contains("favourite") {
      applySuggestedPresentation(name: "Starred", color: "yellow", icon: "star")
    }
  }

  private func applySuggestedPresentation(name suggestedName: String, color suggestedColor: String, icon suggestedIcon: String) {
    if trimmedName.isEmpty {
      name = suggestedName
    }
    if color == FilterEditorOption.colors.first?.id {
      color = suggestedColor
    }
    if icon == FilterEditorOption.icons.first?.id {
      icon = suggestedIcon
    }
  }
}

private struct FilterModeCard: View {
  var title: String
  var subtitle: String
  var systemImage: String
  var tint: Color
  var action: () -> Void

  var body: some View {
    Button(action: action) {
      VStack(alignment: .leading, spacing: 10) {
        Image(systemName: systemImage)
          .font(.title2.weight(.semibold))
          .foregroundStyle(tint)
          .frame(width: 34, height: 34)

        Text(title)
          .font(.headline)
          .foregroundStyle(.primary)

        Text(subtitle)
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      .frame(maxWidth: .infinity, minHeight: 132, alignment: .topLeading)
      .padding(16)
      .background(sheetCardBackground)
      .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .strokeBorder(Color.primary.opacity(0.10))
      )
    }
    .buttonStyle(.plain)
  }
}

private struct FilterAppearanceSection: View {
  @Binding var name: String
  @Binding var color: String
  @Binding var icon: String

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("Appearance")
        .font(.headline)

      HStack(spacing: 12) {
        Image(systemName: icon)
          .font(.title3.weight(.semibold))
          .foregroundStyle(selectedColor)
          .frame(width: 42, height: 42)
          .background(selectedColor.opacity(0.14))
          .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))

        TextField("Name", text: $name)
          .textFieldStyle(.plain)
          .font(.title3.weight(.semibold))

        Picker("Icon", selection: $icon) {
          ForEach(FilterEditorOption.icons) { option in
            Label(option.title, systemImage: option.id).tag(option.id)
          }
        }
        .labelsHidden()
        .frame(width: 120)
      }

      HStack(spacing: 8) {
        ForEach(FilterEditorOption.colors) { option in
          Button {
            color = option.id
          } label: {
            ZStack {
              Circle()
                .fill(option.color)
                .frame(width: 24, height: 24)

              if color == option.id {
                Image(systemName: "checkmark")
                  .font(.caption.weight(.bold))
                  .foregroundStyle(.white)
              }
            }
            .frame(width: 30, height: 30)
          }
          .buttonStyle(.plain)
          .accessibilityLabel(option.title)
          .accessibilityAddTraits(color == option.id ? .isSelected : [])
        }
      }
    }
    .padding(14)
    .background(sheetCardBackground)
    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 8, style: .continuous)
        .strokeBorder(Color.primary.opacity(0.10))
    )
  }

  private var selectedColor: Color {
    FilterEditorOption.colors.first(where: { $0.id == color })?.color ?? .secondary
  }
}

private struct FilterTextField: View {
  var title: String
  var systemImage: String
  @Binding var text: String

  var body: some View {
    HStack(spacing: 10) {
      Label(title, systemImage: systemImage)
        .foregroundStyle(.secondary)
        .frame(width: 150, alignment: .leading)
      TextField(title, text: $text)
        .textFieldStyle(.plain)
    }
    .padding(.vertical, 6)
  }
}

private struct FilterEditorOption: Identifiable {
  var id: String
  var title: String
  var color: Color = .secondary

  static let icons: [FilterEditorOption] = [
    FilterEditorOption(id: "line.3.horizontal.decrease.circle", title: "Filter"),
    FilterEditorOption(id: "tray.full", title: "Inbox"),
    FilterEditorOption(id: "paperclip", title: "Attachment"),
    FilterEditorOption(id: "doc.text", title: "Document"),
    FilterEditorOption(id: "creditcard", title: "Money"),
    FilterEditorOption(id: "cart", title: "Shopping"),
    FilterEditorOption(id: "calendar", title: "Calendar"),
    FilterEditorOption(id: "briefcase", title: "Work"),
    FilterEditorOption(id: "person.crop.circle", title: "People"),
    FilterEditorOption(id: "flag", title: "Flag"),
    FilterEditorOption(id: "star", title: "Star"),
    FilterEditorOption(id: "bell", title: "Alert"),
    FilterEditorOption(id: "bolt", title: "Bolt")
  ]

  static let colors: [FilterEditorOption] = [
    FilterEditorOption(id: "teal", title: "Teal", color: .teal),
    FilterEditorOption(id: "green", title: "Green", color: .green),
    FilterEditorOption(id: "blue", title: "Blue", color: .blue),
    FilterEditorOption(id: "orange", title: "Orange", color: .orange),
    FilterEditorOption(id: "purple", title: "Purple", color: .purple),
    FilterEditorOption(id: "red", title: "Red", color: .red),
    FilterEditorOption(id: "pink", title: "Pink", color: .pink),
    FilterEditorOption(id: "cyan", title: "Cyan", color: .cyan),
    FilterEditorOption(id: "indigo", title: "Indigo", color: .indigo),
    FilterEditorOption(id: "mint", title: "Mint", color: .mint),
    FilterEditorOption(id: "yellow", title: "Yellow", color: .yellow),
    FilterEditorOption(id: "gray", title: "Gray", color: .secondary)
  ]
}

private var sheetCardBackground: Color {
  #if os(macOS)
  Color(nsColor: .controlBackgroundColor)
  #else
  Color(uiColor: .secondarySystemGroupedBackground)
  #endif
}

private extension String {
  var trimmedOrNil: String? {
    let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }
}

private struct SidebarButton: View {
  var title: String
  var subtitle: String?
  var systemImage: String
  var avatarName: String? = nil
  var avatarEmail: String? = nil
  var avatarURL: String? = nil
  var tint: Color = .secondary
  var count: Int = 0
  var isSelected: Bool
  var action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 10) {
        if let avatarName, let avatarEmail {
          AvatarView(
            name: avatarName,
            email: avatarEmail,
            urlString: avatarURL,
            size: 24
          )
          .frame(width: 24)
        } else {
          Image(systemName: systemImage)
            .foregroundStyle(tint)
            .frame(width: 24)
        }

        VStack(alignment: .leading, spacing: 2) {
          Text(title)
            .lineLimit(1)
          if let subtitle, !subtitle.isEmpty {
            Text(subtitle)
              .font(.caption)
              .foregroundStyle(.secondary)
              .lineLimit(1)
          }
        }

        Spacer(minLength: 6)

        if count > 0 {
          Text(count, format: .number)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.secondary)
            .monospacedDigit()
        }
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .listRowBackground(isSelected ? Color.mailSelectionBackground : Color.clear)
  }
}
