import SwiftUI

struct EmailListView: View {
  @Environment(AppModel.self) private var model
  var onCompose: () -> Void
  var onSettings: () -> Void

  var body: some View {
    Group {
      if model.isLoading && model.emails.isEmpty {
        ProgressView()
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else if model.emails.isEmpty {
        ContentUnavailableView("No Messages", systemImage: "tray")
      } else {
        List(selection: selection) {
          ForEach(model.emails) { email in
            EmailRow(email: email)
              .tag(email.id)
              .contentShape(Rectangle())
              .onTapGesture {
                Task { await model.selectEmail(email) }
              }
          }
        }
        .listStyle(.plain)
      }
    }
    .toolbar {
      ToolbarItemGroup {
        Button {
          Task { await model.refreshAll() }
        } label: {
          Image(systemName: "arrow.clockwise")
        }
        .help("Refresh")

        Button(action: onCompose) {
          Image(systemName: "square.and.pencil")
        }
        .help("Compose")

        #if os(macOS)
        SettingsLink {
          Image(systemName: "gearshape")
        }
        #else
        Button(action: onSettings) {
          Image(systemName: "gearshape")
        }
        #endif
      }
    }
  }

  private var selection: Binding<String?> {
    Binding(
      get: { model.selectedEmailID },
      set: { newValue in
        guard
          let newValue,
          let email = model.emails.first(where: { $0.id == newValue })
        else { return }
        Task { await model.selectEmail(email) }
      }
    )
  }
}

private struct EmailRow: View {
  var email: EmailSummary

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      AvatarView(
        name: email.senderName,
        email: email.senderEmail,
        urlString: email.senderAvatarURL,
        size: 34
      )

      VStack(alignment: .leading, spacing: 5) {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Text(email.senderName)
            .font(.subheadline.weight(email.isRead ? .regular : .semibold))
            .lineLimit(1)

          Spacer(minLength: 8)

          Text(MailDateFormatter.listTimestamp(email.receivedAt))
            .font(.caption)
            .foregroundStyle(.secondary)
            .monospacedDigit()
            .lineLimit(1)
        }

        HStack(spacing: 6) {
          if !email.isRead {
            Circle()
              .fill(Color.accentColor)
              .frame(width: 7, height: 7)
          }

          Text(email.subject)
            .font(.subheadline.weight(email.isRead ? .regular : .semibold))
            .lineLimit(1)

          if email.isStarred {
            Image(systemName: "star.fill")
              .font(.caption)
              .foregroundStyle(.yellow)
          }
        }

        Text(email.snippet)
          .font(.caption)
          .foregroundStyle(.secondary)
          .lineLimit(2)

        if !email.labels.isEmpty {
          ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
              ForEach(email.labels) { label in
                LabelChip(label: label)
              }
            }
          }
          .scrollDisabled(true)
        }
      }
    }
    .padding(.vertical, 7)
  }
}

