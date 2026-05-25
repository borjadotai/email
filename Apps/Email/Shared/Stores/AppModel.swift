import Foundation
import Observation
import SwiftUI

struct PendingArchiveNotification: Identifiable, Hashable {
  var id: String
  var subject: String
  var senderName: String
  var secondsRemaining: Int
  var durationSeconds: Int
  var removedFromCurrentList: Bool
  var previousEmails: [EmailSummary]
  var previousSelectedEmailID: String?
  var previousSelectedEmail: EmailDetail?
  var previousConversationEmails: [EmailDetail]
}

@MainActor
@Observable
final class AppModel {
  var accounts: [MailAccount] = []
  var profile: UserProfile?
  var mailboxes: [Mailbox] = []
  var labels: [MailLabel] = []
  var filters: [MailFilter] = []
  var emails: [EmailSummary] = []
  var selectedEmail: EmailDetail?
  var conversationEmails: [EmailDetail] = []
  var selectedEmailID: String?
  var selectedAccountID: String?
  var selectedMailboxID: String?
  var selectedLabelID: String?
  var selectedFilterID: String?
  var searchText: String = ""
  var isLoading = false
  var isRefreshingMail = false
  var refreshStartedAt: Date?
  var isSending = false
  var isConnectingAccount = false
  var syncingAccountID: String?
  var errorMessage: String?
  var statusMessage: String?
  var health: HealthResponse?
  var authSettings: AuthSettings?
  var updatingAccountID: String?
  var shortcutBindings: [MailShortcutBinding] = MailShortcutBinding.defaults {
    didSet {
      Defaults.saveShortcutBindings(shortcutBindings)
    }
  }
  var composeRequestCount = 0
  var composeDraft: ComposeDraft?
  var settingsRequestCount = 0
  var notificationNavigationRequestCount = 0
  var isSearchPresented = false
  var isArchiving = false
  var pendingArchive: PendingArchiveNotification?

  var archiveUndoDurationSeconds: Int {
    didSet {
      let clamped = Defaults.clampedArchiveUndoDuration(archiveUndoDurationSeconds)
      if clamped != archiveUndoDurationSeconds {
        archiveUndoDurationSeconds = clamped
        return
      }
      UserDefaults.standard.set(archiveUndoDurationSeconds, forKey: Defaults.archiveUndoDurationSeconds)
    }
  }

  var serverURLString: String {
    didSet {
      UserDefaults.standard.set(Defaults.normalizedServerURLString(serverURLString), forKey: Defaults.serverURL)
    }
  }

  var themePreference: ThemePreference {
    didSet {
      UserDefaults.standard.set(themePreference.rawValue, forKey: Defaults.theme)
    }
  }

  private var hasBootstrapped = false
  @ObservationIgnored private var pendingArchiveTask: Task<Void, Never>?
  @ObservationIgnored private var isAutoPollingMail = false

  init() {
    var initialServerURL = UserDefaults.standard.string(forKey: Defaults.serverURL) ?? Defaults.defaultServerURL
    if Defaults.isLoopbackURL(initialServerURL), !Defaults.isLoopbackURL(Defaults.defaultServerURL) {
      initialServerURL = Defaults.defaultServerURL
    }
    initialServerURL = Defaults.normalizedServerURLString(initialServerURL)
    UserDefaults.standard.set(initialServerURL, forKey: Defaults.serverURL)
    serverURLString = initialServerURL
    let rawTheme = UserDefaults.standard.string(forKey: Defaults.theme) ?? ThemePreference.system.rawValue
    themePreference = ThemePreference(rawValue: rawTheme) ?? .system
    archiveUndoDurationSeconds = Defaults.loadArchiveUndoDurationSeconds()
    shortcutBindings = Defaults.loadShortcutBindings()
  }

  var colorScheme: ColorScheme? {
    themePreference.colorScheme
  }

  var archiveUndoDurationRange: ClosedRange<Int> {
    Defaults.archiveUndoDurationRange
  }

  var navigationTitle: String {
    if let filter = filters.first(where: { $0.id == selectedFilterID }) {
      return filter.name
    }
    if let label = labels.first(where: { $0.id == selectedLabelID }) {
      return label.name
    }
    if let mailbox = mailboxes.first(where: { $0.id == selectedMailboxID }) {
      return mailbox.name
    }
    if let account = accounts.first(where: { $0.id == selectedAccountID }) {
      return account.displayName
    }
    return "All Inboxes"
  }

  var globalUnreadCount: Int {
    mailboxes
      .filter { $0.role == "inbox" }
      .reduce(0) { $0 + $1.unreadCount }
  }

  var apiClient: MailAPIClient {
    let fallback = URL(string: Defaults.defaultServerURL) ?? URL(string: "http://127.0.0.1:7331")!
    let normalizedURLString = Defaults.normalizedServerURLString(serverURLString)
    return MailAPIClient(baseURL: URL(string: normalizedURLString) ?? fallback)
  }

  var shouldStartBundledServer: Bool {
    Defaults.isLoopbackURL(serverURLString)
  }

  var gmailAuthConfigurationWarning: String? {
    guard authSettings?.gmailConfigured == true,
          let redirectURI = authSettings?.gmailRedirectURI,
          !Defaults.isLoopbackURL(serverURLString),
          Defaults.isLoopbackURL(redirectURI)
    else {
      return nil
    }

    return "Google is still configured to redirect to this Mac. Set EMAIL_PUBLIC_BASE_URL on the email server to its Tailscale HTTPS URL and register that callback in Google Cloud."
  }

  func bootstrap() async {
    guard !hasBootstrapped else { return }
    hasBootstrapped = true
    await refreshAll()
  }

  func refreshAll(reportErrors: Bool = true) async {
    isLoading = true
    defer { isLoading = false }

    do {
      health = try await apiClient.health()
      authSettings = try? await apiClient.authSettings()
      profile = try? await apiClient.profile()
      accounts = try await apiClient.accounts()
      mailboxes = try await apiClient.mailboxes()
      labels = try await apiClient.labels()
      filters = try await apiClient.filters()
      try await loadEmails(refreshFilterCache: selectedFilterID != nil)
    } catch {
      if reportErrors {
        errorMessage = error.localizedDescription
      }
    }
  }

  private func loadEmails(refreshFilterCache: Bool = false) async throws {
    let query = EmailQuery(
      accountId: selectedAccountID,
      mailboxId: selectedMailboxID,
      mailboxRole: defaultMailboxRole,
      labelId: selectedLabelID,
      filterId: selectedFilterID,
      q: searchText,
      refreshFilterCache: refreshFilterCache
    )
    let pendingArchiveID = pendingArchive?.id
    emails = try await apiClient.emails(query: query)
      .filter { $0.id != pendingArchiveID }

    if let selectedEmailID, emails.contains(where: { $0.id == selectedEmailID }) {
      if let loadedEmail = try? await apiClient.email(id: selectedEmailID) {
        guard self.selectedEmailID == selectedEmailID else { return }
        selectedEmail = loadedEmail
        let loadedConversation = (try? await apiClient.thread(emailId: loadedEmail.id)) ?? [loadedEmail]
        guard self.selectedEmailID == selectedEmailID else { return }
        conversationEmails = loadedConversation
      } else if self.selectedEmailID == selectedEmailID {
        selectedEmail = nil
        conversationEmails = []
      }
    } else {
      selectedEmailID = nil
      selectedEmail = nil
      conversationEmails = []
    }
  }

  func refreshEmails(refreshFilterCache: Bool = false) async {
    do {
      try await loadEmails(refreshFilterCache: refreshFilterCache)
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func refreshVisibleMail() async {
    guard !isRefreshingMail else { return }
    isRefreshingMail = true
    refreshStartedAt = Date()
    let accountIds = visibleAccountIDsForRefresh()
    defer {
      isRefreshingMail = false
      refreshStartedAt = nil
      syncingAccountID = nil
    }

    if accountIds.isEmpty {
      await refreshAll()
      return
    }

    var syncErrors: [String] = []
    for accountId in accountIds {
      syncingAccountID = accountId
      do {
        _ = try await apiClient.syncAccount(id: accountId, limit: 50)
      } catch {
        syncErrors.append(error.localizedDescription)
      }
    }

    if let firstError = syncErrors.first {
      errorMessage = firstError
    } else {
      errorMessage = nil
      statusMessage = "Mail refreshed"
    }
    await refreshAll()
  }

  func pollAllMailForNewEmails() async -> [String] {
    guard !isRefreshingMail, !isAutoPollingMail else { return [] }
    isAutoPollingMail = true
    defer { isAutoPollingMail = false }

    if accounts.isEmpty {
      await refreshAll(reportErrors: false)
    }

    let accountIDs = accounts.map(\.id)
    guard !accountIDs.isEmpty else { return [] }

    var newEmailIDs: [String] = []
    for accountID in accountIDs {
      do {
        let result = try await apiClient.syncAccount(id: accountID, limit: 50)
        newEmailIDs.append(contentsOf: result.newEmailIds ?? [])
      } catch {
        continue
      }
    }

    await refreshAll(reportErrors: false)
    return uniqueEmailIDs(newEmailIDs)
  }

  func emailDetails(for ids: [String]) async -> [EmailDetail] {
    var details: [EmailDetail] = []
    for id in uniqueEmailIDs(ids) {
      do {
        let detail = try await apiClient.email(id: id)
        guard !detail.isRead, detail.mailboxRole == "inbox" else { continue }
        details.append(detail)
      } catch {
        continue
      }
    }
    return details
  }

  private func refreshSelectedFilterCache(filterID: String) async {
    guard selectedFilterID == filterID else { return }
    do {
      try await loadEmails(refreshFilterCache: true)
      filters = try await apiClient.filters()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func checkHealth() async {
    do {
      health = try await apiClient.health()
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func selectGlobalInbox() async {
    selectedAccountID = nil
    selectedMailboxID = nil
    selectedLabelID = nil
    selectedFilterID = nil
    await refreshEmails()
  }

  func selectAccount(_ account: MailAccount) async {
    selectedAccountID = account.id
    selectedMailboxID = nil
    selectedLabelID = nil
    selectedFilterID = nil
    await refreshEmails()
  }

  func selectMailbox(_ mailbox: Mailbox) async {
    selectedAccountID = mailbox.accountId
    selectedMailboxID = mailbox.id
    selectedLabelID = nil
    selectedFilterID = nil
    await refreshEmails()
  }

  func selectLabel(_ label: MailLabel) async {
    selectedAccountID = label.accountId ?? selectedAccountID
    selectedMailboxID = nil
    selectedLabelID = label.id
    selectedFilterID = nil
    await refreshEmails()
  }

  func selectFilter(_ filter: MailFilter) async {
    selectedAccountID = nil
    selectedMailboxID = nil
    selectedLabelID = nil
    selectedFilterID = filter.id
    await refreshEmails()
    await refreshSelectedFilterCache(filterID: filter.id)
  }

  func createGlobalLabel(name: String, color: String, icon: String) async {
    do {
      let label = try await apiClient.createLabel(name: name, color: color, icon: icon)
      labels = try await apiClient.labels()
      await selectLabel(label)
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func updateLabel(_ label: MailLabel, name: String, color: String, icon: String) async {
    do {
      let updated = try await apiClient.updateLabel(id: label.id, name: name, color: color, icon: icon)
      labels = labels.map { $0.id == updated.id ? updated : $0 }
      try await loadEmails()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func createFilter(naturalLanguage: String) async {
    do {
      let filter = try await apiClient.createFilter(naturalLanguage: naturalLanguage)
      filters = try await apiClient.filters()
      await selectFilter(filter)
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func updateFilter(
    _ filter: MailFilter,
    naturalLanguage: String
  ) async {
    do {
      let updated = try await apiClient.updateFilter(
        id: filter.id,
        naturalLanguage: naturalLanguage
      )
      filters = filters.map { $0.id == updated.id ? updated : $0 }
      if selectedFilterID == updated.id {
        try await loadEmails(refreshFilterCache: true)
      }
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func deleteFilter(_ filter: MailFilter) async {
    do {
      _ = try await apiClient.deleteFilter(id: filter.id)
      filters.removeAll { $0.id == filter.id }
      if selectedFilterID == filter.id {
        selectedFilterID = nil
        selectedEmailID = nil
        selectedEmail = nil
        conversationEmails = []
        try await loadEmails()
      }
      statusMessage = "Filter deleted"
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func labelsAvailable(for email: EmailDetail) -> [MailLabel] {
    labels.filter { label in
      label.accountId == nil || label.accountId == email.accountId
    }
  }

  func selectEmail(_ summary: EmailSummary) async {
    await selectEmail(id: summary.id)
  }

  func beginSelectingEmail(id: String) {
    selectedEmailID = id
    if selectedEmail?.id != id {
      selectedEmail = nil
      conversationEmails = []
    }
  }

  func selectEmail(id: String) async {
    beginSelectingEmail(id: id)
    do {
      var detail = try await apiClient.email(id: id)
      guard selectedEmailID == id else { return }

      if !detail.isRead {
        detail = try await apiClient.updateEmail(id: detail.id, isRead: true)
        guard selectedEmailID == id else { return }
        await refreshAll(reportErrors: false)
        guard selectedEmailID == id else { return }
      }

      selectedEmail = detail
      conversationEmails = [detail]

      do {
        let thread = try await apiClient.thread(emailId: detail.id)
        guard selectedEmailID == id else { return }
        conversationEmails = thread
      } catch {
        guard selectedEmailID == id else { return }
        conversationEmails = [detail]
      }
    } catch {
      guard selectedEmailID == id else { return }
      errorMessage = error.localizedDescription
      selectedEmail = nil
      conversationEmails = []
    }
  }

  func openEmailFromNotification(id: String) async {
    await selectEmail(id: id)
    if selectedEmailID == id {
      notificationNavigationRequestCount += 1
    }
  }

  func addAccount(provider: MailProvider, email: String, displayName: String, syncHistory: Bool) async {
    do {
      _ = try await apiClient.addAccount(AddAccountRequest(
        provider: provider,
        email: email,
        displayName: displayName,
        syncHistory: syncHistory
      ))
      await refreshAll()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func startGmailAuth(displayName: String, syncHistory: Bool) async -> URL? {
    isConnectingAccount = true
    statusMessage = "Starting Google sign-in"
    errorMessage = nil
    defer { isConnectingAccount = false }

    do {
      let response = try await apiClient.startGmailAuth(GmailAuthStartRequest(
        displayName: displayName,
        syncHistory: syncHistory
      ))
      errorMessage = nil
      statusMessage = nil
      return URL(string: response.authorizationURL)
    } catch {
      errorMessage = error.localizedDescription
      statusMessage = nil
      return nil
    }
  }

  func connectICloud(email: String, username: String, displayName: String, appPassword: String, syncHistory: Bool) async -> Bool {
    isConnectingAccount = true
    statusMessage = "Connecting iCloud Mail"
    errorMessage = nil
    defer { isConnectingAccount = false }

    do {
      let trimmedUsername = username.trimmingCharacters(in: .whitespacesAndNewlines)
      let result = try await apiClient.connectICloud(ICloudConnectRequest(
        email: email,
        username: trimmedUsername.isEmpty ? nil : trimmedUsername,
        displayName: displayName,
        appPassword: appPassword,
        syncHistory: syncHistory
      ))
      statusMessage = "Imported \(result.sync.imported) messages"
      errorMessage = nil
      await refreshAll()
      return true
    } catch {
      errorMessage = error.localizedDescription
      statusMessage = nil
      return false
    }
  }

  func syncAccount(_ account: MailAccount) async {
    syncingAccountID = account.id
    defer { syncingAccountID = nil }

    do {
      let result = try await apiClient.syncAccount(id: account.id)
      statusMessage = "Imported \(result.imported) messages"
      errorMessage = nil
      await refreshAll()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func updateAccountSettings(_ account: MailAccount, displayName: String, avatarURL: String, syncHistory: Bool) async -> Bool {
    let trimmedDisplayName = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedDisplayName.isEmpty else {
      errorMessage = "Display name cannot be empty."
      return false
    }
    let trimmedAvatarURL = avatarURL.trimmingCharacters(in: .whitespacesAndNewlines)

    updatingAccountID = account.id
    defer { updatingAccountID = nil }

    do {
      let updated = try await apiClient.updateAccount(
        id: account.id,
        UpdateAccountSettingsRequest(
          displayName: trimmedDisplayName,
          avatarURL: trimmedAvatarURL,
          syncHistory: syncHistory
        )
      )
      if let index = accounts.firstIndex(where: { $0.id == updated.id }) {
        accounts[index] = updated
      }
      profile = try? await apiClient.profile()
      mailboxes = try await apiClient.mailboxes()
      statusMessage = "Updated \(updated.displayName)"
      errorMessage = nil
      try await loadEmails()
      return true
    } catch {
      errorMessage = error.localizedDescription
      return false
    }
  }

  func send(_ request: SendMessageRequest) async -> Bool {
    isSending = true
    defer { isSending = false }

    do {
      let response = try await apiClient.send(request)
      selectedEmailID = response.email.id
      selectedEmail = response.email
      conversationEmails = try await apiClient.thread(emailId: response.email.id)
      await refreshAll()
      return true
    } catch {
      errorMessage = error.localizedDescription
      return false
    }
  }

  func requestCompose() {
    composeDraft = nil
    composeRequestCount += 1
  }

  func requestReply(to email: EmailDetail? = nil) {
    guard let email = email ?? selectedEmail else { return }
    composeDraft = ComposeDraft.reply(to: email)
    composeRequestCount += 1
  }

  func requestSettings() {
    settingsRequestCount += 1
  }

  func shortcut(for action: MailShortcutAction) -> MailKeyboardShortcut {
    shortcutBindings.first(where: { $0.action == action })?.shortcut ?? action.defaultShortcut
  }

  func updateShortcut(_ action: MailShortcutAction, key: String? = nil, modifierPreset: MailShortcutModifierPreset? = nil) {
    let current = shortcut(for: action)
    let updated = MailKeyboardShortcut(
      key: key ?? current.key,
      modifierPreset: modifierPreset ?? current.modifierPreset
    )
    let next = shortcutBindings.filter { $0.action != action } + [
      MailShortcutBinding(action: action, shortcut: updated)
    ]
    shortcutBindings = sortedShortcutBindings(next)
  }

  func resetShortcuts() {
    shortcutBindings = MailShortcutBinding.defaults
  }

  func shortcutConflict(for action: MailShortcutAction) -> MailShortcutAction? {
    let shortcut = shortcut(for: action)
    return MailShortcutAction.allCases.first { otherAction in
      otherAction != action && self.shortcut(for: otherAction) == shortcut
    }
  }

  func performShortcutAction(_ action: MailShortcutAction) async {
    switch action {
    case .compose:
      requestCompose()
    case .archive:
      await archiveSelectedEmail()
    case .refresh:
      await refreshAll()
    case .search:
      isSearchPresented = true
    case .toggleRead:
      await toggleSelectedRead()
    case .toggleStar:
      await toggleSelectedStar()
    case .markSpam:
      await markSelectedSpam()
    }
  }

  func archiveSelectedEmail() async {
    guard !isArchiving, let selectedEmailID else { return }
    let selectedSummary = emails.first { $0.id == selectedEmailID }
    let loadedSelectedEmail = selectedEmail?.id == selectedEmailID ? selectedEmail : nil

    queueArchive(
      id: selectedEmailID,
      subject: loadedSelectedEmail?.subject ?? selectedSummary?.subject ?? "Message",
      senderName: loadedSelectedEmail?.senderName ?? selectedSummary?.senderName ?? "Sender"
    )
  }

  func archiveEmail(_ email: EmailSummary) async {
    queueArchive(
      id: email.id,
      subject: email.subject,
      senderName: email.senderName
    )
  }

  func trashEmail(_ email: EmailSummary) async {
    await trashEmail(id: email.id)
  }

  func markSpam(_ email: EmailSummary) async {
    await markSpam(id: email.id)
  }

  func toggleRead(_ email: EmailSummary) async {
    do {
      let updated = try await apiClient.updateEmail(id: email.id, isRead: !email.isRead)
      applyEmailUpdate(updated)
      try await loadEmails()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func undoPendingArchive() {
    guard let pendingArchive else { return }
    pendingArchiveTask?.cancel()
    pendingArchiveTask = nil

    withAnimation(.snappy(duration: 0.24)) {
      if pendingArchive.removedFromCurrentList {
        emails = pendingArchive.previousEmails
        selectedEmailID = pendingArchive.previousSelectedEmailID
        selectedEmail = pendingArchive.previousSelectedEmail
        conversationEmails = pendingArchive.previousConversationEmails
      }
      self.pendingArchive = nil
    }

    statusMessage = "Archive undone"
    errorMessage = nil
  }

  private func queueArchive(id: String, subject: String, senderName: String) {
    guard pendingArchive?.id != id else { return }

    if let previousPendingArchive = pendingArchive {
      pendingArchiveTask?.cancel()
      pendingArchiveTask = nil
      withAnimation(.snappy(duration: 0.18)) {
        pendingArchive = nil
      }
      Task {
        await commitArchive(previousPendingArchive)
      }
    }

    let previousEmails = emails
    let previousSelectedEmailID = selectedEmailID
    let previousSelectedEmail = selectedEmail
    let previousConversationEmails = conversationEmails
    let shouldRemoveImmediately = shouldRemoveArchivedEmailFromCurrentList(emailId: id)
    let replacementSelectedEmailID = selectedEmailID == id && shouldRemoveImmediately
      ? nextVisibleEmailID(afterRemoving: id, from: previousEmails)
      : nil

    if shouldRemoveImmediately {
      withAnimation(.snappy(duration: 0.24)) {
        emails.removeAll { $0.id == id }
        if selectedEmailID == id {
          selectedEmailID = replacementSelectedEmailID
          selectedEmail = nil
          conversationEmails = []
        }
      }
    }

    let duration = Defaults.clampedArchiveUndoDuration(archiveUndoDurationSeconds)
    let archive = PendingArchiveNotification(
      id: id,
      subject: subject,
      senderName: senderName,
      secondsRemaining: duration,
      durationSeconds: duration,
      removedFromCurrentList: shouldRemoveImmediately,
      previousEmails: previousEmails,
      previousSelectedEmailID: previousSelectedEmailID,
      previousSelectedEmail: previousSelectedEmail,
      previousConversationEmails: previousConversationEmails
    )

    withAnimation(.snappy(duration: 0.24)) {
      pendingArchive = archive
    }
    if let replacementSelectedEmailID {
      loadEmailIfStillSelected(id: replacementSelectedEmailID)
    }
    statusMessage = "Archiving in \(duration)s"
    errorMessage = nil
    schedulePendingArchiveCommit(id: id, duration: duration)
  }

  private func nextVisibleEmailID(afterRemoving id: String, from visibleEmails: [EmailSummary]) -> String? {
    guard let removedIndex = visibleEmails.firstIndex(where: { $0.id == id }) else {
      return nil
    }

    let nextIndex = visibleEmails.index(after: removedIndex)
    if nextIndex < visibleEmails.endIndex {
      return visibleEmails[nextIndex].id
    }

    if removedIndex > visibleEmails.startIndex {
      return visibleEmails[visibleEmails.index(before: removedIndex)].id
    }

    return nil
  }

  private func loadEmailIfStillSelected(id: String) {
    Task { @MainActor in
      guard selectedEmailID == id else { return }
      await selectEmail(id: id)
    }
  }

  private func schedulePendingArchiveCommit(id: String, duration: Int) {
    pendingArchiveTask?.cancel()
    pendingArchiveTask = Task { @MainActor in
      if duration > 1 {
        for remaining in stride(from: duration - 1, through: 1, by: -1) {
          try? await Task.sleep(for: .seconds(1))
          guard !Task.isCancelled, pendingArchive?.id == id else { return }
          pendingArchive?.secondsRemaining = remaining
        }
      }

      try? await Task.sleep(for: .seconds(1))
      guard !Task.isCancelled, let archive = pendingArchive, archive.id == id else { return }
      pendingArchiveTask = nil
      withAnimation(.easeOut(duration: 0.2)) {
        pendingArchive = nil
      }
      await commitArchive(archive)
    }
  }

  private func commitArchive(_ archive: PendingArchiveNotification) async {
    isArchiving = true
    defer { isArchiving = false }

    do {
      let updated = try await apiClient.archiveEmail(emailId: archive.id)
      statusMessage = "Archived"
      errorMessage = nil
      if !archive.removedFromCurrentList {
        applyEmailUpdate(updated)
      }
      mailboxes = try await apiClient.mailboxes()
      try await loadEmails()
    } catch {
      if archive.removedFromCurrentList {
        withAnimation(.snappy(duration: 0.24)) {
          emails = archive.previousEmails
          selectedEmailID = archive.previousSelectedEmailID
          selectedEmail = archive.previousSelectedEmail
          conversationEmails = archive.previousConversationEmails
        }
      }
      errorMessage = error.localizedDescription
    }
  }

  private func trashEmail(id: String) async {
    do {
      let updated = try await apiClient.trashEmail(emailId: id)
      statusMessage = "Moved to Trash"
      errorMessage = nil
      applyEmailUpdate(updated)
      try await loadEmails()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func markSpam(id: String) async {
    do {
      let updated = try await apiClient.markSpam(emailId: id)
      statusMessage = "Moved to Spam"
      errorMessage = nil
      applyEmailUpdate(updated)
      try await loadEmails()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func toggleSelectedRead() async {
    guard let selectedEmail else { return }
    await updateSelectedEmail(isRead: !selectedEmail.isRead, isStarred: nil)
  }

  func toggleSelectedStar() async {
    guard let selectedEmail else { return }
    await updateSelectedEmail(isRead: nil, isStarred: !selectedEmail.isStarred)
  }

  func toggleLabel(_ label: MailLabel) async {
    guard let selectedEmail else { return }
    let action = selectedEmail.labels.contains(where: { $0.id == label.id }) ? "remove" : "add"
    do {
      self.selectedEmail = try await apiClient.setLabel(emailId: selectedEmail.id, labelId: label.id, action: action)
      try await loadEmails()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func moveSelectedEmail(to mailbox: Mailbox) async {
    guard let selectedEmail else { return }
    do {
      self.selectedEmail = try await apiClient.updateEmail(id: selectedEmail.id, mailboxId: mailbox.id)
      await refreshAll()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func markSelectedSpam() async {
    guard let selectedEmail else { return }
    do {
      self.selectedEmail = try await apiClient.markSpam(emailId: selectedEmail.id)
      statusMessage = "Moved to Spam"
      errorMessage = nil
      await refreshAll()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func blockSelectedSender(scope: BlockSenderScope) async {
    guard let selectedEmail else { return }
    do {
      let result = try await apiClient.blockSender(emailId: selectedEmail.id, scope: scope)
      self.selectedEmail = result.email
      statusMessage = blockStatusMessage(scope: result.rule.scope, value: result.rule.value, affectedCount: result.affectedCount)
      errorMessage = nil
      await refreshAll()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func updateSelectedEmail(isRead: Bool?, isStarred: Bool?) async {
    guard let selectedEmail else { return }
    do {
      self.selectedEmail = try await apiClient.updateEmail(id: selectedEmail.id, isRead: isRead, isStarred: isStarred)
      try await loadEmails()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func blockStatusMessage(scope: BlockSenderScope, value: String, affectedCount: Int) -> String {
    let target = scope == .domain ? value : value
    let messageCount = affectedCount == 1 ? "1 message" : "\(affectedCount) messages"
    return "Blocked \(target). Moved \(messageCount) to Spam."
  }

  private func applyEmailUpdate(_ email: EmailDetail) {
    if selectedEmailID == email.id {
      selectedEmail = email
    }
  }

  private var defaultMailboxRole: String? {
    selectedMailboxID == nil && selectedLabelID == nil ? "inbox" : nil
  }

  private func shouldRemoveArchivedEmailFromCurrentList(emailId: String) -> Bool {
    guard emails.contains(where: { $0.id == emailId }) else {
      return false
    }

    if let selectedMailboxID,
       let mailbox = mailboxes.first(where: { $0.id == selectedMailboxID }) {
      return mailbox.role == "inbox"
    }

    return defaultMailboxRole == "inbox"
  }

  private func sortedShortcutBindings(_ bindings: [MailShortcutBinding]) -> [MailShortcutBinding] {
    MailShortcutAction.allCases.map { action in
      bindings.first(where: { $0.action == action }) ?? MailShortcutBinding(action: action, shortcut: action.defaultShortcut)
    }
  }

  private func visibleAccountIDsForRefresh() -> [String] {
    if let selectedAccountID {
      return [selectedAccountID]
    }

    if let selectedMailboxID,
       let accountID = mailboxes.first(where: { $0.id == selectedMailboxID })?.accountId {
      return [accountID]
    }

    if let selectedLabelID,
       let accountID = labels.first(where: { $0.id == selectedLabelID })?.accountId {
      return [accountID]
    }

    return accounts.map(\.id)
  }

  private func uniqueEmailIDs(_ ids: [String]) -> [String] {
    var seen = Set<String>()
    return ids.filter { seen.insert($0).inserted }
  }
}

private enum Defaults {
  static let serverURL = "email.serverURL"
  static let theme = "email.theme"
  static let shortcutBindings = "email.shortcutBindings.v1"
  static let archiveUndoDurationSeconds = "email.archiveUndoDurationSeconds"
  static let defaultArchiveUndoDurationSeconds = 4
  static let archiveUndoDurationRange = 1...15

  static var defaultServerURL: String {
    Bundle.main.object(forInfoDictionaryKey: "EmailDefaultServerURL") as? String ?? "http://127.0.0.1:7331"
  }

  static func normalizedServerURLString(_ value: String) -> String {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let url = URL(string: trimmed) else {
      return trimmed
    }

    return MailAPIClient.normalizedServerBaseURL(url).absoluteString.trimmingTrailingSlash
  }

  static func isLoopbackURL(_ value: String) -> Bool {
    guard let host = URLComponents(string: value)?.host?.lowercased() else { return false }
    return host == "127.0.0.1" || host == "localhost" || host == "::1"
  }

  static func loadShortcutBindings() -> [MailShortcutBinding] {
    guard
      let data = UserDefaults.standard.data(forKey: shortcutBindings),
      let decoded = try? JSONDecoder().decode([MailShortcutBinding].self, from: data)
    else {
      return MailShortcutBinding.defaults
    }

    return MailShortcutAction.allCases.map { action in
      decoded.first(where: { $0.action == action }) ?? MailShortcutBinding(action: action, shortcut: action.defaultShortcut)
    }
  }

  static func saveShortcutBindings(_ bindings: [MailShortcutBinding]) {
    guard let data = try? JSONEncoder().encode(bindings) else { return }
    UserDefaults.standard.set(data, forKey: shortcutBindings)
  }

  static func loadArchiveUndoDurationSeconds() -> Int {
    let value = UserDefaults.standard.integer(forKey: archiveUndoDurationSeconds)
    guard value > 0 else { return defaultArchiveUndoDurationSeconds }
    return clampedArchiveUndoDuration(value)
  }

  static func clampedArchiveUndoDuration(_ value: Int) -> Int {
    min(max(value, archiveUndoDurationRange.lowerBound), archiveUndoDurationRange.upperBound)
  }
}

private extension String {
  var trimmingTrailingSlash: String {
    count > 1 && hasSuffix("/") ? String(dropLast()) : self
  }
}
