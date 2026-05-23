import SwiftUI

struct EmailPreviewView: View {
  @Environment(AppModel.self) private var model
  var onCompose: () -> Void

  var body: some View {
    Group {
      if let email = model.selectedEmail {
        ScrollView {
          VStack(alignment: .leading, spacing: 22) {
            header(email)
            Divider()
            bodyText(email)
          }
          .padding(28)
          .frame(maxWidth: 860, alignment: .leading)
        }
        .background(.background)
        .toolbar {
          ToolbarItemGroup {
            Button {
              Task { await model.toggleSelectedRead() }
            } label: {
              Image(systemName: email.isRead ? "envelope.badge" : "envelope.open")
            }
            .help(email.isRead ? "Mark unread" : "Mark read")

            Button {
              Task { await model.toggleSelectedStar() }
            } label: {
              Image(systemName: email.isStarred ? "star.fill" : "star")
            }
            .help("Star")

            Menu {
              ForEach(model.labels) { label in
                Button {
                  Task { await model.toggleLabel(label) }
                } label: {
                  let isApplied = email.labels.contains(where: { $0.id == label.id })
                  Label(label.name, systemImage: isApplied ? "checkmark.circle.fill" : "circle")
                }
              }
            } label: {
              Image(systemName: "tag")
            }
            .help("Labels")

            Menu {
              ForEach(model.mailboxes.filter { $0.accountId == email.accountId }) { mailbox in
                Button {
                  Task { await model.moveSelectedEmail(to: mailbox) }
                } label: {
                  Label(mailbox.name, systemImage: mailbox.id == email.mailboxId ? "checkmark.circle.fill" : "folder")
                }
              }
            } label: {
              Image(systemName: "folder")
            }
            .help("Move")
          }
        }
      } else {
        ContentUnavailableView("Select a Message", systemImage: "envelope.open")
          .toolbar {
            Button(action: onCompose) {
              Image(systemName: "square.and.pencil")
            }
          }
      }
    }
  }

  private func header(_ email: EmailDetail) -> some View {
    VStack(alignment: .leading, spacing: 16) {
      Text(email.subject)
        .font(.title2.weight(.semibold))
        .textSelection(.enabled)
        .fixedSize(horizontal: false, vertical: true)

      HStack(alignment: .top, spacing: 12) {
        AvatarView(
          name: email.senderName,
          email: email.senderEmail,
          urlString: email.senderAvatarURL,
          size: 40
        )

        VStack(alignment: .leading, spacing: 6) {
          Text(email.senderName)
            .font(.headline)
            .lineLimit(1)

          Text(email.senderEmail)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .textSelection(.enabled)

          Text("To \(email.recipients.joined(separator: ", "))")
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(2)
        }

        Spacer()

        VStack(alignment: .trailing, spacing: 6) {
          Text(MailDateFormatter.listTimestamp(email.receivedAt))
            .font(.caption)
            .foregroundStyle(.secondary)
            .monospacedDigit()

          if let openedAt = email.openedAt {
            Label(MailDateFormatter.listTimestamp(openedAt), systemImage: "eye")
              .font(.caption)
              .foregroundStyle(.secondary)
          }
        }
      }

      if !email.labels.isEmpty {
        HStack(spacing: 5) {
          ForEach(email.labels) { label in
            LabelChip(label: label)
          }
        }
      }
    }
  }

  private func bodyText(_ email: EmailDetail) -> some View {
    Text(email.bodyText)
      .font(.body)
      .lineSpacing(4)
      .textSelection(.enabled)
      .frame(maxWidth: .infinity, alignment: .leading)
  }
}
