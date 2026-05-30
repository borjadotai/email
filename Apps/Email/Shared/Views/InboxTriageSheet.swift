import SwiftUI

struct InboxTriageSheet: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  @State private var expandedSectionIDs: Set<String> = ["read", "archive"]
  @State private var hasLoaded = false
  var onOpenEmail: () -> Void

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          if model.isLoadingInboxTriage && model.inboxTriage == nil {
            loadingState
          } else if let triage = model.inboxTriage {
            header(triage)

            if !triage.summaryBullets.isEmpty {
              SummaryBulletGroup(title: "Quick Summary", bullets: triage.summaryBullets)
            }

            ForEach(triage.sections) { section in
              InboxTriageSectionView(
                section: section,
                isExpanded: isExpandedBinding(for: section.id),
                onOpenEmail: openEmail
              )
            }
          } else {
            unavailableState
          }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 22)
        .frame(maxWidth: 760, alignment: .leading)
        .frame(maxWidth: .infinity)
      }
      .background(TriageSurface.background)
      .navigationTitle("Unread Triage")
      #if os(iOS)
      .navigationBarTitleDisplayMode(.inline)
      #endif
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done") {
            dismiss()
          }
        }

        ToolbarItem(placement: .primaryAction) {
          Button {
            Task { await model.loadInboxTriage(force: true) }
          } label: {
            if model.isLoadingInboxTriage {
              ProgressView()
                .controlSize(.small)
            } else {
              Label("Refresh", systemImage: "arrow.clockwise")
            }
          }
          .disabled(model.isLoadingInboxTriage)
        }
      }
      .task {
        guard !hasLoaded else { return }
        hasLoaded = true
        await model.loadInboxTriage(force: false)
      }
      .onChange(of: model.inboxTriage?.id) { _, _ in
        expandedSectionIDs = ["read", "archive"]
      }
    }
    #if os(iOS)
    .presentationDetents([.large])
    .presentationDragIndicator(.visible)
    #endif
  }

  private var loadingState: some View {
    VStack(spacing: 14) {
      ProgressView()
        .controlSize(.large)
      Text("Reading unread mail")
        .font(.headline)
      Text("Classifying messages into what can wait and what is worth your attention.")
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
    }
    .frame(maxWidth: .infinity, minHeight: 260)
  }

  private var unavailableState: some View {
    ContentUnavailableView(
      model.inboxTriageErrorMessage ?? "No unread messages to triage",
      systemImage: model.inboxTriageErrorMessage == nil ? "tray" : "exclamationmark.triangle"
    )
    .frame(maxWidth: .infinity, minHeight: 260)
  }

  private func header(_ triage: InboxTriageResult) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .firstTextBaseline, spacing: 10) {
        Image(systemName: "sparkles")
          .font(.title3.weight(.semibold))
          .foregroundStyle(Color.accentColor)

        Text(titleText(for: triage))
          .font(.title2.weight(.bold))
          .lineLimit(2)
          .minimumScaleFactor(0.78)
      }

      HStack(spacing: 8) {
        Label(sourceText(for: triage), systemImage: triage.isCached ? "clock.arrow.circlepath" : "wand.and.stars")
        Text("·")
        Text("\(triage.analyzedCount) analyzed")
        Text("·")
        Text("\(triage.unreadCount) unread")
      }
      .font(.caption)
      .foregroundStyle(.secondary)

      if let error = triage.error, !error.isEmpty {
        Label(error, systemImage: "exclamationmark.triangle")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    }
  }

  private func titleText(for triage: InboxTriageResult) -> String {
    if triage.unreadCount == 0 {
      return "Inbox is clear"
    }
    return "Here is what needs attention"
  }

  private func sourceText(for triage: InboxTriageResult) -> String {
    if triage.isCached {
      return "Ready"
    }
    switch triage.source {
    case "codex":
      return "AI triage"
    case "empty":
      return "No unread mail"
    default:
      return "Local triage"
    }
  }

  private func isExpandedBinding(for id: String) -> Binding<Bool> {
    Binding(
      get: { expandedSectionIDs.contains(id) },
      set: { isExpanded in
        if isExpanded {
          expandedSectionIDs.insert(id)
        } else {
          expandedSectionIDs.remove(id)
        }
      }
    )
  }

  private func openEmail(_ email: InboxTriageEmail) {
    onOpenEmail()
    Task {
      await model.openEmailFromNotification(id: email.id)
    }
  }
}

private struct InboxTriageSectionView: View {
  var section: InboxTriageSection
  @Binding var isExpanded: Bool
  var onOpenEmail: (InboxTriageEmail) -> Void

  var body: some View {
    DisclosureGroup(isExpanded: $isExpanded) {
      VStack(spacing: 10) {
        if section.emails.isEmpty {
          Text(emptyText)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 10)
        } else {
          ForEach(section.emails) { email in
            InboxTriageEmailRow(email: email) {
              onOpenEmail(email)
            }
          }
        }
      }
      .padding(.top, 10)
    } label: {
      HStack(spacing: 10) {
        Image(systemName: section.intent == .read ? "eyeglasses" : "archivebox")
          .font(.headline)
          .foregroundStyle(section.intent == .read ? Color.accentColor : .secondary)
          .frame(width: 24)

        Text(section.title)
          .font(.headline)

        Spacer()

        Text("\(section.count)")
          .font(.caption.weight(.semibold))
          .foregroundStyle(.secondary)
          .padding(.horizontal, 8)
          .padding(.vertical, 4)
          .background(.quaternary, in: Capsule())
      }
      .contentShape(Rectangle())
    }
    .tint(.primary)
  }

  private var emptyText: String {
    section.intent == .read
      ? "Nothing urgent stood out."
      : "Nothing looks safe to archive."
  }
}

private struct InboxTriageEmailRow: View {
  var email: InboxTriageEmail
  var onOpen: () -> Void

  var body: some View {
    Button(action: onOpen) {
      HStack(alignment: .top, spacing: 12) {
        AvatarView(
          name: email.senderName,
          email: email.senderEmail,
          urlString: email.senderAvatarURL,
          size: 38,
          prefersLogo: true
        )

        VStack(alignment: .leading, spacing: 7) {
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(email.senderName)
              .font(.subheadline.weight(.semibold))
              .foregroundStyle(.primary)
              .lineLimit(1)

            Spacer(minLength: 8)

            Text(MailDateFormatter.inboxTimestamp(email.receivedAt))
              .font(.caption)
              .foregroundStyle(.secondary)
              .monospacedDigit()
              .lineLimit(1)
          }

          Text(subjectText)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.primary)
            .lineLimit(2)

          Text(email.reason)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(2)

          if email.intent == .read && !email.summaryBullets.isEmpty {
            SummaryBulletGroup(title: nil, bullets: email.summaryBullets)
              .padding(.top, 1)
          } else if email.intent == .archive {
            Text(email.snippet.mailPreviewText)
              .font(.caption)
              .foregroundStyle(.secondary)
              .lineLimit(2)
          }
        }
      }
      .padding(12)
      .background(TriageSurface.cardBackground, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .stroke(.quaternary, lineWidth: 1)
      )
    }
    .buttonStyle(.plain)
  }

  private var subjectText: String {
    let trimmed = email.subject.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? "(No subject)" : trimmed
  }
}

private struct SummaryBulletGroup: View {
  var title: String?
  var bullets: [String]

  var body: some View {
    VStack(alignment: .leading, spacing: 7) {
      if let title {
        Text(title)
          .font(.headline)
      }

      ForEach(Array(bullets.enumerated()), id: \.offset) { _, bullet in
        HStack(alignment: .firstTextBaseline, spacing: 7) {
          Circle()
            .fill(.secondary)
            .frame(width: 4, height: 4)
            .alignmentGuide(.firstTextBaseline) { context in
              context[VerticalAlignment.center]
            }

          Text(bullet)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

private enum TriageSurface {
  static var background: Color {
    #if os(iOS)
    Color(uiColor: .systemGroupedBackground)
    #else
    Color(nsColor: .windowBackgroundColor)
    #endif
  }

  static var cardBackground: Color {
    #if os(iOS)
    Color(uiColor: .secondarySystemGroupedBackground)
    #else
    Color(nsColor: .controlBackgroundColor)
    #endif
  }
}
