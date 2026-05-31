import SwiftUI

struct EmailListView: View {
  @Environment(AppModel.self) private var model
  @State private var isToolbarRefreshing = false
  @State private var selectionTask: Task<Void, Never>?
  @State private var archivingEmailIDs = Set<String>()
  #if os(macOS)
  @FocusState private var isMessageListFocused: Bool
  #endif
  var onCompose: () -> Void
  var onTriage: () -> Void
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
        Button(action: onTriage) {
          if model.isLoadingInboxTriage {
            ProgressView()
              .controlSize(.small)
          } else {
            Image(systemName: "sparkles")
          }
        }
        .disabled(!model.canTriageCurrentInbox || model.currentInboxUnreadCount == 0 || model.isLoadingInboxTriage)
        .help("Triage unread mail")
        .accessibilityLabel("Triage unread mail")

        #if os(iOS)
        if model.showsIOSRefreshButton {
          refreshToolbarButton
        }
        #else
        refreshToolbarButton
        #endif

        Button(action: onCompose) {
          Image(systemName: "square.and.pencil")
        }
        .help("Compose")
      }
    }
  }

  #if os(iOS)
  private var iOSBody: some View {
    List {
      IOSInboxHeader(
        title: iOSInboxTitle,
        filters: model.filters,
        selectedFilterID: model.selectedFilterID,
        showsFilters: showsSavedFilterPills,
        onSelectAll: {
          Task { await model.selectGlobalInbox() }
        },
        onSelectFilter: { filter in
          Task { await model.selectFilter(filter) }
        }
      )
      .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 6, trailing: 0))
      .listRowSeparator(.hidden)
      .listRowBackground(Color.clear)

      if model.isLoadingEmails && model.emails.isEmpty && !model.isRefreshingMail {
        EmailListSkeletonRows()
          .listRowSeparator(.hidden)
          .listRowBackground(Color.clear)
      } else if filteredEmails.isEmpty {
        ContentUnavailableView(emptyTitle, systemImage: "tray")
          .frame(maxWidth: .infinity, minHeight: 220)
          .listRowSeparator(.hidden)
          .listRowBackground(Color.clear)
      } else {
        if model.isLoadingEmails && !model.isRefreshingMail {
          EmailListLoadingStatusRow(title: "Loading")
            .listRowInsets(EdgeInsets(top: 4, leading: 20, bottom: 8, trailing: 18))
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
        }

        ForEach(Array(groupedEmails.enumerated()), id: \.element.id) { index, section in
          IOSDateSectionHeader(
            title: section.title,
            topPadding: index == 0 ? 14 : 28
          )
          .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
          .listRowSeparator(.hidden)
          .listRowBackground(Color.clear)

          ForEach(section.emails) { email in
            let isArchiving = archivingEmailIDs.contains(email.id)
            IOSMailRow(
              email: email,
              isSelected: model.selectedEmailID == email.id
            )
            .tag(email.id)
            .contentShape(Rectangle())
            .opacity(isArchiving ? 0 : 1)
            .offset(x: isArchiving ? 140 : 0)
            .animation(.easeOut(duration: 0.18), value: isArchiving)
            .transition(.asymmetric(
              insertion: .opacity,
              removal: .identity
            ))
            .onTapGesture {
              select(email)
            }
            .onAppear {
              model.loadMoreEmailsIfNeeded(current: email)
            }
            .mailRowSwipeActions(email: email, model: model) {
              archive(email)
            }
            .listRowInsets(EdgeInsets(top: 2, leading: 20, bottom: 9, trailing: 18))
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
          }
        }

        if model.isLoadingMoreEmails {
          EmailListLoadingStatusRow(title: "Loading more")
            .listRowInsets(EdgeInsets(top: 6, leading: 20, bottom: 18, trailing: 18))
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
        }
      }
    }
    .listStyle(.plain)
    .scrollContentBackground(.hidden)
    .background(.background)
    .animation(.easeOut(duration: 0.22), value: filteredEmails.map(\.id))
    .animation(.snappy(duration: 0.2), value: model.isRefreshingMail)
    .mailPullToRefresh(model)
    .navigationBarTitleDisplayMode(.inline)
  }
  #endif

  #if os(macOS)
  private var macOSBody: some View {
    Group {
      if model.isLoadingEmails && model.emails.isEmpty {
        EmailListSkeletonRows()
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
      } else if model.emails.isEmpty {
        ContentUnavailableView("No Messages", systemImage: "tray")
      } else {
        ScrollViewReader { proxy in
          List {
            if model.isLoadingEmails {
              EmailListLoadingStatusRow(title: "Loading")
                .listRowInsets(EdgeInsets(top: 8, leading: 14, bottom: 8, trailing: 14))
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
            }

            ForEach(Array(model.emails.enumerated()), id: \.element.id) { index, email in
              EmailRow(
                email: email,
                showsSeparator: index < model.emails.count - 1
              )
                .id(email.id)
                .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
                .listRowSeparator(.hidden)
                .listRowBackground(model.selectedEmailID == email.id ? Color.mailSelectionBackground : Color.clear)
                .contentShape(Rectangle())
                .accessibilityAddTraits(model.selectedEmailID == email.id ? .isSelected : [])
                .transition(.asymmetric(
                  insertion: .opacity,
                  removal: .move(edge: .trailing).combined(with: .opacity)
                ))
                .onTapGesture {
                  select(email)
                }
                .onAppear {
                  model.loadMoreEmailsIfNeeded(current: email)
                }
                .mailRowSwipeActions(email: email, model: model) {
                  Task { await model.archiveEmail(email) }
                }
            }

            if model.isLoadingMoreEmails {
              EmailListLoadingStatusRow(title: "Loading more")
                .listRowInsets(EdgeInsets(top: 10, leading: 14, bottom: 16, trailing: 14))
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
            }
          }
          .listStyle(.plain)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .clipped()
          .focusable()
          .focused($isMessageListFocused)
          .onAppear {
            isMessageListFocused = true
          }
          .onMoveCommand { direction in
            selectEmail(for: direction)
          }
          .onKeyPress(.upArrow) {
            selectAdjacentEmail(offset: -1)
            return .handled
          }
          .onKeyPress(.downArrow) {
            selectAdjacentEmail(offset: 1)
            return .handled
          }
          .onChange(of: model.selectedEmailID) { _, selectedEmailID in
            guard let selectedEmailID else { return }
            withAnimation(.snappy(duration: 0.18)) {
              proxy.scrollTo(selectedEmailID, anchor: .center)
            }
          }
          .animation(.snappy(duration: 0.24), value: model.emails.map(\.id))
          .mailPullToRefresh(model)
        }
      }
    }
  }
  #endif

  private func select(_ email: EmailSummary) {
    #if os(macOS)
    isMessageListFocused = true
    #endif

    if model.selectedEmailID == email.id,
       model.selectedEmail?.id == email.id,
       model.selectedEmailLoadErrorMessage == nil {
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

  private var showsToolbarRefreshProgress: Bool {
    #if os(iOS)
    isToolbarRefreshing
    #else
    model.isRefreshingMail || isToolbarRefreshing
    #endif
  }

  private var refreshToolbarButton: some View {
    Button {
      refreshFromToolbar()
    } label: {
      if showsToolbarRefreshProgress {
        ProgressView()
          .controlSize(.small)
      } else {
        Image(systemName: "arrow.clockwise")
      }
    }
    .disabled(model.isRefreshingMail || isToolbarRefreshing)
    .help("Refresh")
    .accessibilityLabel(showsToolbarRefreshProgress ? "Refreshing mail" : "Refresh")
  }

  private func refreshFromToolbar() {
    guard !isToolbarRefreshing else { return }
    Task { @MainActor in
      isToolbarRefreshing = true
      defer { isToolbarRefreshing = false }
      await model.refreshVisibleMail()
    }
  }

  #if os(iOS)
  private func archive(_ email: EmailSummary) {
    guard !archivingEmailIDs.contains(email.id) else { return }

    withAnimation(.easeOut(duration: 0.18)) {
      _ = archivingEmailIDs.insert(email.id)
    }

    Task { @MainActor in
      try? await Task.sleep(for: .milliseconds(180))
      await model.archiveEmail(email)
      archivingEmailIDs.remove(email.id)
    }
  }
  #endif

  #if os(macOS)
  private func selectEmail(for direction: MoveCommandDirection) {
    switch direction {
    case .up:
      selectAdjacentEmail(offset: -1)
    case .down:
      selectAdjacentEmail(offset: 1)
    default:
      break
    }
  }

  private func selectAdjacentEmail(offset: Int) {
    guard !model.emails.isEmpty else { return }

    let currentIndex = model.selectedEmailID.flatMap { selectedEmailID in
      model.emails.firstIndex { $0.id == selectedEmailID }
    }
    let targetIndex: Int
    if let currentIndex {
      targetIndex = min(max(currentIndex + offset, 0), model.emails.count - 1)
    } else {
      targetIndex = offset < 0 ? model.emails.count - 1 : 0
    }

    guard currentIndex != targetIndex else { return }
    select(model.emails[targetIndex])
  }
  #endif

  #if os(iOS)
  private var filteredEmails: [EmailSummary] {
    model.emails
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
    model.navigationTitle
  }

  private var showsSavedFilterPills: Bool {
    guard model.selectedGlobalFolder == nil,
          model.selectedMailboxID == nil,
          model.selectedLabelID == nil else {
      return false
    }

    return !model.filters.isEmpty
  }

  private var emptyTitle: String {
    guard let selectedFilterID = model.selectedFilterID,
          let filter = model.filters.first(where: { $0.id == selectedFilterID }) else {
      return "No Messages"
    }
    return "No \(filter.name) Messages"
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
  func mailRowSwipeActions(
    email: EmailSummary,
    model: AppModel,
    archiveAction: @escaping () -> Void
  ) -> some View {
    #if os(iOS)
    swipeActions(edge: .trailing, allowsFullSwipe: true) {
      Button(action: archiveAction) {
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

private struct EmailListLoadingStatusRow: View {
  var title: String

  var body: some View {
    HStack(spacing: 8) {
      ProgressView()
        .controlSize(.small)
      Text(title)
        .font(.caption)
        .foregroundStyle(.secondary)
      Spacer()
    }
    .padding(.vertical, 4)
  }
}

private struct EmailListSkeletonRows: View {
  private let rows = Array(0..<8)

  var body: some View {
    VStack(spacing: 0) {
      ForEach(rows, id: \.self) { index in
        EmailRowSkeleton()
          .opacity(index < 3 ? 1 : 0.76)
      }
    }
    .redacted(reason: .placeholder)
    .allowsHitTesting(false)
  }
}

private struct EmailRowSkeleton: View {
  var body: some View {
    VStack(spacing: 0) {
      HStack(alignment: .top, spacing: 12) {
        Circle()
          .fill(.secondary.opacity(0.22))
          .frame(width: 34, height: 34)

        VStack(alignment: .leading, spacing: 8) {
          HStack {
            RoundedRectangle(cornerRadius: 3)
              .fill(.secondary.opacity(0.26))
              .frame(width: 130, height: 11)

            Spacer()

            RoundedRectangle(cornerRadius: 3)
              .fill(.secondary.opacity(0.18))
              .frame(width: 44, height: 9)
          }

          RoundedRectangle(cornerRadius: 3)
            .fill(.secondary.opacity(0.22))
            .frame(height: 10)

          RoundedRectangle(cornerRadius: 3)
            .fill(.secondary.opacity(0.16))
            .frame(height: 9)
        }
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 14)

      Divider()
        .padding(.leading, 60)
    }
  }
}

private struct EmailRow: View {
  var email: EmailSummary
  var showsSeparator = true

  var body: some View {
    VStack(spacing: 0) {
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
            .lineLimit(1)

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
      .padding(.leading, 18)
      .padding(.trailing, 14)
      .padding(.vertical, 10)

      if showsSeparator {
        Divider()
      }
    }
  }
}

#if os(iOS)
private struct IOSInboxHeader: View {
  var title: String
  var filters: [MailFilter]
  var selectedFilterID: String?
  var showsFilters: Bool
  var onSelectAll: () -> Void
  var onSelectFilter: (MailFilter) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text(title)
        .font(.system(size: 40, weight: .bold))
        .foregroundStyle(.primary)
        .lineLimit(1)
        .minimumScaleFactor(0.72)
        .padding(.horizontal, 20)
        .accessibilityAddTraits(.isHeader)

      if showsFilters {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 12) {
            Button {
              withAnimation(.snappy(duration: 0.2)) {
                onSelectAll()
              }
            } label: {
              Text("All")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(selectedFilterID == nil ? Color.primary : Color.primary.opacity(0.92))
                .padding(.horizontal, 17)
                .padding(.vertical, 8)
                .background(pillFill(isSelected: selectedFilterID == nil), in: Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(selectedFilterID == nil ? .isSelected : [])

            ForEach(filters) { filter in
              Button {
                withAnimation(.snappy(duration: 0.2)) {
                  onSelectFilter(filter)
                }
              } label: {
                Text(filter.name)
                  .font(.system(size: 16, weight: .semibold))
                  .foregroundStyle(filter.id == selectedFilterID ? Color.primary : Color.primary.opacity(0.92))
                  .padding(.horizontal, 17)
                  .padding(.vertical, 8)
                  .background(pillFill(isSelected: filter.id == selectedFilterID), in: Capsule())
              }
              .buttonStyle(.plain)
              .accessibilityAddTraits(filter.id == selectedFilterID ? .isSelected : [])
            }
          }
          .padding(.horizontal, 20)
        }
        .scrollClipDisabled()
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func pillFill(isSelected: Bool) -> Color {
    isSelected
      ? Color.cyan.opacity(0.38)
      : Color.secondary.opacity(0.10)
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
