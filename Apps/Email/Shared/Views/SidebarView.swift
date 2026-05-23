import SwiftUI

struct SidebarView: View {
  @Environment(AppModel.self) private var model
  var onAddAccount: () -> Void

  var body: some View {
    List {
      Section {
        SidebarButton(
          title: "All Inboxes",
          subtitle: "Global",
          systemImage: "tray.full",
          count: model.globalUnreadCount,
          isSelected: model.selectedAccountID == nil && model.selectedMailboxID == nil && model.selectedLabelID == nil
        ) {
          Task { await model.selectGlobalInbox() }
        }
      }

      if !model.accounts.isEmpty {
        Section("Accounts") {
          ForEach(model.accounts) { account in
            SidebarButton(
              title: account.displayName,
              subtitle: account.email,
              systemImage: account.provider.systemImage,
              count: unreadCount(for: account),
              isSelected: model.selectedAccountID == account.id && model.selectedMailboxID == nil && model.selectedLabelID == nil
            ) {
              Task { await model.selectAccount(account) }
            }
          }
        }
      }

      if !model.mailboxes.isEmpty {
        Section("Folders") {
          ForEach(model.mailboxes) { mailbox in
            SidebarButton(
              title: mailbox.name,
              subtitle: mailbox.accountEmail,
              systemImage: image(for: mailbox.role),
              count: mailbox.unreadCount,
              isSelected: model.selectedMailboxID == mailbox.id
            ) {
              Task { await model.selectMailbox(mailbox) }
            }
          }
        }
      }

      if !model.labels.isEmpty {
        Section("Labels") {
          ForEach(model.labels) { label in
            SidebarButton(
              title: label.name,
              subtitle: label.accountEmail,
              systemImage: "tag",
              tint: label.swiftUIColor,
              isSelected: model.selectedLabelID == label.id
            ) {
              Task { await model.selectLabel(label) }
            }
          }
        }
      }
    }
    .listStyle(.sidebar)
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

  private func image(for role: String) -> String {
    switch role {
    case "inbox": "tray"
    case "sent": "paperplane"
    case "drafts": "doc"
    case "archive": "archivebox"
    case "trash": "trash"
    default: "folder"
    }
  }
}

private struct SidebarButton: View {
  var title: String
  var subtitle: String?
  var systemImage: String
  var tint: Color = .secondary
  var count: Int = 0
  var isSelected: Bool
  var action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 10) {
        Image(systemName: systemImage)
          .foregroundStyle(tint)
          .frame(width: 18)

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

