import SwiftUI

struct SidebarView: View {
  @Environment(AppModel.self) private var model
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
          isSelected: model.selectedAccountID == nil && model.selectedMailboxID == nil && model.selectedLabelID == nil
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
      return model.labels.filter { label in
        label.accountId == nil || label.accountId == accountID
      }
    }

    guard model.selectedLabelID != nil else { return [] }
    return model.labels.filter { $0.accountId == nil }
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
    .listRowBackground(isSelected ? Color.accentColor.opacity(0.14) : Color.clear)
  }
}
