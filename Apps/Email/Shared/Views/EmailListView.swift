import SwiftUI

struct EmailListView: View {
  @Environment(AppModel.self) private var model
  #if os(iOS)
  @State private var selectedFilter: InboxFilter = .all
  #endif
  @State private var selectionTask: Task<Void, Never>?
  var onCompose: () -> Void
  var onSettings: () -> Void
  var onShowDetail: () -> Void

  var body: some View {
    Group {
      #if os(iOS)
      iOSBody
      #else
      macOSBody
      #endif
    }
    .toolbar {
      ToolbarItemGroup {
        Button {
          Task { await model.refreshVisibleMail() }
        } label: {
          if model.isRefreshingMail {
            ProgressView()
              .controlSize(.small)
          } else {
            Image(systemName: "arrow.clockwise")
          }
        }
        .disabled(model.isRefreshingMail)
        .help("Refresh")
        .accessibilityLabel(model.isRefreshingMail ? "Refreshing mail" : "Refresh")

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

  #if os(iOS)
  private var iOSBody: some View {
    List {
      IOSInboxHeader(
        title: iOSInboxTitle,
        selectedFilter: $selectedFilter
      )
      .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 6, trailing: 0))
      .listRowSeparator(.hidden)
      .listRowBackground(Color.clear)

      if model.isRefreshingMail {
        IOSRefreshStatusRow(
          scopeTitle: refreshScopeTitle,
          startedAt: model.refreshStartedAt
        )
        .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 10, trailing: 18))
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
        .transition(.move(edge: .top).combined(with: .opacity))
      }

      if model.isLoading && model.emails.isEmpty {
        ProgressView()
          .frame(maxWidth: .infinity, minHeight: 220)
          .listRowSeparator(.hidden)
          .listRowBackground(Color.clear)
      } else if filteredEmails.isEmpty {
        ContentUnavailableView(emptyTitle, systemImage: "tray")
          .frame(maxWidth: .infinity, minHeight: 220)
          .listRowSeparator(.hidden)
          .listRowBackground(Color.clear)
      } else {
        ForEach(Array(groupedEmails.enumerated()), id: \.element.id) { index, section in
          IOSDateSectionHeader(
            title: section.title,
            topPadding: index == 0 ? 14 : 28
          )
          .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
          .listRowSeparator(.hidden)
          .listRowBackground(Color.clear)

          ForEach(section.emails) { email in
            IOSMailRow(
              email: email,
              isSelected: model.selectedEmailID == email.id
            )
            .tag(email.id)
            .contentShape(Rectangle())
            .transition(.asymmetric(
              insertion: .opacity,
              removal: .move(edge: .trailing).combined(with: .opacity)
            ))
            .onTapGesture {
              select(email)
            }
            .mailRowSwipeActions(email: email, model: model)
            .listRowInsets(EdgeInsets(top: 2, leading: 20, bottom: 9, trailing: 18))
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
          }
        }
      }
    }
    .listStyle(.plain)
    .scrollContentBackground(.hidden)
    .background(.background)
    .animation(.snappy(duration: 0.24), value: filteredEmails.map(\.id))
    .animation(.snappy(duration: 0.2), value: model.isRefreshingMail)
    .mailPullToRefresh(model)
    .navigationBarTitleDisplayMode(.inline)
  }
  #endif

  #if os(macOS)
  private var macOSBody: some View {
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
              .listRowInsets(EdgeInsets(top: 0, leading: 18, bottom: 0, trailing: 14))
              .contentShape(Rectangle())
              .transition(.asymmetric(
                insertion: .opacity,
                removal: .move(edge: .trailing).combined(with: .opacity)
              ))
              .onTapGesture {
                select(email)
              }
              .mailRowSwipeActions(email: email, model: model)
          }
        }
        .listStyle(.plain)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .clipped()
        .animation(.snappy(duration: 0.24), value: model.emails.map(\.id))
        .mailPullToRefresh(model)
      }
    }
  }
  #endif

  private var selection: Binding<String?> {
    Binding(
      get: { model.selectedEmailID },
      set: { newValue in
        guard
          let newValue,
          let email = model.emails.first(where: { $0.id == newValue })
        else { return }
        select(email)
      }
    )
  }

  private func select(_ email: EmailSummary) {
    guard model.selectedEmailID != email.id else {
      onShowDetail()
      return
    }
    model.beginSelectingEmail(id: email.id)
    onShowDetail()
    selectionTask?.cancel()
    selectionTask = Task {
      await model.selectEmail(email)
    }
  }

  #if os(iOS)
  private var filteredEmails: [EmailSummary] {
    model.emails
      .filter { selectedFilter.matches($0) }
      .sorted { first, second in
        emailDate(first) > emailDate(second)
      }
  }

  private var groupedEmails: [InboxDateSection] {
    let grouped = Dictionary(grouping: filteredEmails) { email in
      InboxDateBucket.bucket(for: email.receivedAt)
    }

    return InboxDateBucket.allCases.compactMap { bucket in
      guard let emails = grouped[bucket], !emails.isEmpty else { return nil }
      return InboxDateSection(bucket: bucket, emails: emails)
    }
  }

  private var iOSInboxTitle: String {
    "Inbox"
  }

  private var refreshScopeTitle: String {
    if let syncingAccountID = model.syncingAccountID,
       let account = model.accounts.first(where: { $0.id == syncingAccountID }) {
      return account.displayName
    }

    return model.navigationTitle
  }

  private var emptyTitle: String {
    selectedFilter == .all ? "No Messages" : "No \(selectedFilter.title) Messages"
  }

  private func emailDate(_ email: EmailSummary) -> Date {
    MailDateFormatter.date(from: email.receivedAt) ?? .distantPast
  }
  #endif
}

private extension View {
  @ViewBuilder
  func mailPullToRefresh(_ model: AppModel) -> some View {
    #if os(iOS)
    refreshable {
      await model.refreshVisibleMail()
    }
    #else
    self
    #endif
  }

  @ViewBuilder
  func mailRowSwipeActions(email: EmailSummary, model: AppModel) -> some View {
    #if os(iOS)
    swipeActions(edge: .trailing, allowsFullSwipe: true) {
      Button {
        Task { await model.archiveEmail(email) }
      } label: {
        Label("Archive", systemImage: "archivebox")
      }
      .tint(.blue)

      Button(role: .destructive) {
        Task { await model.trashEmail(email) }
      } label: {
        Label("Delete", systemImage: "trash")
      }

      Button {
        Task { await model.markSpam(email) }
      } label: {
        Label("Spam", systemImage: "exclamationmark.octagon")
      }
      .tint(.orange)

      Button {
        Task { await model.toggleRead(email) }
      } label: {
        Label(email.isRead ? "Unread" : "Read", systemImage: email.isRead ? "envelope.badge" : "envelope.open")
      }
      .tint(.gray)
    }
    #else
    self
    #endif
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
        size: 34,
        prefersLogo: true
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

        Text(email.snippet.mailPreviewText)
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

#if os(iOS)
private struct IOSInboxHeader: View {
  var title: String
  @Binding var selectedFilter: InboxFilter

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text(title)
        .font(.system(size: 40, weight: .bold))
        .foregroundStyle(.primary)
        .lineLimit(1)
        .minimumScaleFactor(0.72)
        .padding(.horizontal, 20)
        .accessibilityAddTraits(.isHeader)

      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 12) {
          ForEach(InboxFilter.allCases) { filter in
            Button {
              withAnimation(.snappy(duration: 0.2)) {
                selectedFilter = filter
              }
            } label: {
              Text(filter.title)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(filter == selectedFilter ? Color.primary : Color.primary.opacity(0.92))
                .padding(.horizontal, 17)
                .padding(.vertical, 8)
                .background(pillFill(for: filter), in: Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(filter == selectedFilter ? .isSelected : [])
          }
        }
        .padding(.horizontal, 20)
      }
      .scrollClipDisabled()
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func pillFill(for filter: InboxFilter) -> Color {
    filter == selectedFilter
      ? Color.cyan.opacity(0.38)
      : Color.secondary.opacity(0.10)
  }
}

private struct IOSRefreshStatusRow: View {
  var scopeTitle: String
  var startedAt: Date?

  var body: some View {
    TimelineView(.periodic(from: startedAt ?? Date(), by: 1)) { timeline in
      HStack(spacing: 10) {
        ProgressView()
          .controlSize(.small)
          .frame(width: 20, height: 20)

        VStack(alignment: .leading, spacing: 1) {
          Text("Refreshing \(scopeTitle)")
            .font(.system(size: 14.5, weight: .semibold))
            .foregroundStyle(.primary)
            .lineLimit(1)

          Text(elapsedText(now: timeline.date))
            .font(.system(size: 13))
            .foregroundStyle(.secondary)
            .monospacedDigit()
            .lineLimit(1)
        }

        Spacer(minLength: 8)
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 9)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(Color.secondary.opacity(0.10), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("Refreshing \(scopeTitle)")
      .accessibilityValue(elapsedText(now: timeline.date))
    }
  }

  private func elapsedText(now: Date) -> String {
    let startedAt = startedAt ?? now
    let elapsedSeconds = max(0, Int(now.timeIntervalSince(startedAt)))
    let minutes = elapsedSeconds / 60
    let seconds = elapsedSeconds % 60
    let paddedSeconds = seconds < 10 ? "0\(seconds)" : "\(seconds)"
    return "\(minutes):\(paddedSeconds) elapsed"
  }
}

private struct IOSDateSectionHeader: View {
  var title: String
  var topPadding: CGFloat

  var body: some View {
    Text(title)
      .font(.system(size: 16, weight: .bold))
      .foregroundStyle(.primary)
      .lineLimit(1)
      .padding(.top, topPadding)
      .padding(.bottom, 9)
      .padding(.horizontal, 20)
      .frame(maxWidth: .infinity, alignment: .leading)
      .accessibilityAddTraits(.isHeader)
  }
}

private struct IOSMailRow: View {
  var email: EmailSummary
  var isSelected: Bool

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      AvatarView(
        name: email.senderName,
        email: email.senderEmail,
        urlString: email.senderAvatarURL,
        size: 40,
        prefersLogo: true
      )

      VStack(alignment: .leading, spacing: 2) {
        HStack(alignment: .center, spacing: 8) {
          HStack(alignment: .center, spacing: 6) {
            if !email.isRead {
              Circle()
                .fill(Color.accentColor)
                .frame(width: 9, height: 9)
            }

            Text(email.senderName)
              .font(.system(size: 16.5, weight: email.isRead ? .semibold : .bold))
              .foregroundStyle(.primary)
              .lineLimit(1)
          }

          Spacer(minLength: 8)

          HStack(spacing: 6) {
            if email.hasAttachments {
              Image(systemName: "paperclip")
                .font(.system(size: 15))
                .foregroundStyle(.secondary)
            }

            Text(MailDateFormatter.inboxTimestamp(email.receivedAt))
              .font(.system(size: 15))
              .foregroundStyle(.secondary)
              .monospacedDigit()
              .lineLimit(1)
          }
        }

        Text(subjectText)
          .font(.system(size: 15.5, weight: email.isRead ? .regular : .semibold))
          .foregroundStyle(.primary)
          .lineLimit(1)

        HStack(alignment: .center, spacing: 8) {
          Text(email.snippet.mailPreviewText)
            .font(.system(size: 15.5))
            .foregroundStyle(.secondary)
            .lineLimit(1)

          if email.isStarred {
            Image(systemName: "star.fill")
              .font(.caption)
              .foregroundStyle(.yellow)
          }

          Spacer(minLength: 6)

          if !email.isRead {
            Capsule()
              .fill(Color.accentColor)
              .frame(width: 4, height: 18)
          }
        }
      }
    }
    .padding(.vertical, 2)
  }

  private var subjectText: String {
    let trimmed = email.subject.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? "(No subject)" : trimmed
  }
}

private enum InboxFilter: String, CaseIterable, Identifiable {
  case all
  case primary
  case promotions
  case social
  case updates

  var id: String { rawValue }

  var title: String {
    switch self {
    case .all: "All"
    case .primary: "Primary"
    case .promotions: "Promotions"
    case .social: "Social"
    case .updates: "Updates"
    }
  }

  func matches(_ email: EmailSummary) -> Bool {
    switch self {
    case .all:
      return true
    case .primary:
      return !Self.categoryText(for: email).contains("category_")
        && !Self.hasCategoryLabel(email, terms: ["promotions", "social", "updates"])
    case .promotions:
      return Self.hasCategoryLabel(email, terms: ["category_promotions", "promotions", "promotion"])
    case .social:
      return Self.hasCategoryLabel(email, terms: ["category_social", "social"])
    case .updates:
      return Self.hasCategoryLabel(email, terms: ["category_updates", "updates", "notifications"])
    }
  }

  private static func hasCategoryLabel(_ email: EmailSummary, terms: [String]) -> Bool {
    let text = categoryText(for: email)
    return terms.contains { text.contains($0) }
  }

  private static func categoryText(for email: EmailSummary) -> String {
    ([email.mailboxName, email.importance] + email.labels.map(\.name))
      .joined(separator: " ")
      .lowercased()
  }
}

private struct InboxDateSection: Identifiable {
  var bucket: InboxDateBucket
  var emails: [EmailSummary]

  var id: InboxDateBucket { bucket }
  var title: String { bucket.title }
}

private enum InboxDateBucket: Int, CaseIterable {
  case today
  case yesterday
  case thisWeek
  case older

  var title: String {
    switch self {
    case .today: "Today"
    case .yesterday: "Yesterday"
    case .thisWeek: "This Week"
    case .older: "Older"
    }
  }

  @MainActor
  static func bucket(for value: String) -> InboxDateBucket {
    guard let date = MailDateFormatter.date(from: value) else {
      return .older
    }

    let calendar = Calendar.current
    if calendar.isDateInToday(date) {
      return .today
    }
    if calendar.isDateInYesterday(date) {
      return .yesterday
    }
    if let week = calendar.dateInterval(of: .weekOfYear, for: Date()),
       week.contains(date) {
      return .thisWeek
    }
    return .older
  }
}
#endif
