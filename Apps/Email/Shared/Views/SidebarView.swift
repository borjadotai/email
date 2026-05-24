import SwiftUI

struct SidebarView: View {
  @Environment(AppModel.self) private var model
  @State private var labelEditor: GlobalLabelEditorContext?
  var onAddAccount: () -> Void
  var onShowMessages: () -> Void

  var body: some View {
    let visibleMailboxes = scopedMailboxes
    let visibleLabels = scopedLabels
    let visibleGlobalLabels = globalLabels

    List {
      Section {
        SidebarButton(
          title: "All Inboxes",
          subtitle: "Global",
          systemImage: "tray.full",
          count: model.globalUnreadCount,
          isSelected: model.selectedAccountID == nil && model.selectedMailboxID == nil && model.selectedLabelID == nil
        ) {
          onShowMessages()
          Task {
            await model.selectGlobalInbox()
          }
        }
      }

      if activeSidebarAccountID == nil {
        Section("Global Labels") {
          ForEach(visibleGlobalLabels) { label in
            SidebarButton(
              title: label.name,
              subtitle: "Global",
              systemImage: label.systemImage,
              tint: label.swiftUIColor,
              isSelected: model.selectedLabelID == label.id
            ) {
              onShowMessages()
              Task {
                await model.selectLabel(label)
              }
            }
            .contextMenu {
              if !label.isSystem {
                Button("Edit Label") {
                  labelEditor = .edit(label)
                }
              }
            }
          }

          SidebarButton(
            title: "New Label",
            subtitle: nil,
            systemImage: "plus.circle",
            tint: .secondary,
            isSelected: false
          ) {
            labelEditor = .create
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
              isSelected: model.selectedAccountID == account.id && model.selectedMailboxID == nil && model.selectedLabelID == nil
            ) {
              onShowMessages()
              Task {
                await model.selectAccount(account)
              }
            }
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
    .sheet(item: $labelEditor) { context in
      GlobalLabelEditorSheet(context: context) { name, color, icon in
        Task {
          if let label = context.label {
            await model.updateLabel(label, name: name, color: color, icon: icon)
          } else {
            await model.createGlobalLabel(name: name, color: color, icon: icon)
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

  private var globalLabels: [MailLabel] {
    model.labels.filter { $0.accountId == nil }
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

private struct GlobalLabelEditorContext: Identifiable {
  var id: String
  var label: MailLabel?

  static var create: GlobalLabelEditorContext {
    GlobalLabelEditorContext(id: "create-\(UUID().uuidString)", label: nil)
  }

  static func edit(_ label: MailLabel) -> GlobalLabelEditorContext {
    GlobalLabelEditorContext(id: "edit-\(label.id)", label: label)
  }
}

private struct GlobalLabelEditorSheet: View {
  @Environment(\.dismiss) private var dismiss
  var context: GlobalLabelEditorContext
  var onSave: (String, String, String) -> Void

  @State private var name: String
  @State private var color: String
  @State private var icon: String

  init(context: GlobalLabelEditorContext, onSave: @escaping (String, String, String) -> Void) {
    self.context = context
    self.onSave = onSave
    _name = State(initialValue: context.label?.name ?? "")
    _color = State(initialValue: context.label?.color ?? LabelEditorOption.colors[0].id)
    _icon = State(initialValue: context.label?.systemImage ?? LabelEditorOption.icons[0].id)
  }

  var body: some View {
    NavigationStack {
      Form {
        Section("Label") {
          TextField("Name", text: $name)
        }

        Section("Icon") {
          Picker("Icon", selection: $icon) {
            ForEach(LabelEditorOption.icons) { option in
              Label(option.title, systemImage: option.id)
                .tag(option.id)
            }
          }
        }

        Section("Color") {
          LazyVGrid(columns: [GridItem(.adaptive(minimum: 42), spacing: 10)], spacing: 10) {
            ForEach(LabelEditorOption.colors) { option in
              Button {
                color = option.id
              } label: {
                ZStack {
                  Circle()
                    .fill(option.color)
                    .frame(width: 26, height: 26)

                  if color == option.id {
                    Image(systemName: "checkmark")
                      .font(.caption.weight(.bold))
                      .foregroundStyle(.white)
                  }
                }
                .frame(width: 42, height: 34)
              }
              .buttonStyle(.plain)
              .accessibilityLabel(option.title)
              .accessibilityAddTraits(color == option.id ? .isSelected : [])
            }
          }
          .padding(.vertical, 4)
        }
      }
      .navigationTitle(context.label == nil ? "New Label" : "Edit Label")
      #if os(iOS)
      .navigationBarTitleDisplayMode(.inline)
      #endif
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") {
            dismiss()
          }
        }

        ToolbarItem(placement: .confirmationAction) {
          Button("Save") {
            onSave(trimmedName, color, icon)
            dismiss()
          }
          .disabled(trimmedName.isEmpty)
        }
      }
    }
    #if os(macOS)
    .frame(width: 380, height: 420)
    #endif
  }

  private var trimmedName: String {
    name.trimmingCharacters(in: .whitespacesAndNewlines)
  }
}

private struct LabelEditorOption: Identifiable {
  var id: String
  var title: String
  var color: Color = .secondary

  static let icons: [LabelEditorOption] = [
    LabelEditorOption(id: "tag", title: "Tag"),
    LabelEditorOption(id: "folder", title: "Folder"),
    LabelEditorOption(id: "flag", title: "Flag"),
    LabelEditorOption(id: "star", title: "Star"),
    LabelEditorOption(id: "bolt", title: "Bolt"),
    LabelEditorOption(id: "checkmark.circle", title: "Done"),
    LabelEditorOption(id: "clock", title: "Later"),
    LabelEditorOption(id: "calendar", title: "Calendar"),
    LabelEditorOption(id: "briefcase", title: "Work"),
    LabelEditorOption(id: "person.crop.circle", title: "People"),
    LabelEditorOption(id: "creditcard", title: "Money"),
    LabelEditorOption(id: "doc.text", title: "Document"),
    LabelEditorOption(id: "paperclip", title: "Attachment"),
    LabelEditorOption(id: "bell", title: "Alert"),
    LabelEditorOption(id: "flame", title: "Hot")
  ]

  static let colors: [LabelEditorOption] = [
    LabelEditorOption(id: "blue", title: "Blue", color: .blue),
    LabelEditorOption(id: "green", title: "Green", color: .green),
    LabelEditorOption(id: "orange", title: "Orange", color: .orange),
    LabelEditorOption(id: "purple", title: "Purple", color: .purple),
    LabelEditorOption(id: "red", title: "Red", color: .red),
    LabelEditorOption(id: "pink", title: "Pink", color: .pink),
    LabelEditorOption(id: "teal", title: "Teal", color: .teal),
    LabelEditorOption(id: "cyan", title: "Cyan", color: .cyan),
    LabelEditorOption(id: "indigo", title: "Indigo", color: .indigo),
    LabelEditorOption(id: "mint", title: "Mint", color: .mint),
    LabelEditorOption(id: "yellow", title: "Yellow", color: .yellow),
    LabelEditorOption(id: "gray", title: "Gray", color: .secondary)
  ]
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
