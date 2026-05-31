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

private struct EmailListCacheKey: Hashable {
  var accountId: String?
  var mailboxId: String?
  var mailboxRole: String?
  var labelId: String?
  var filterId: String?
  var query: String
  var unreadOnly: Bool

  init(query: EmailQuery) {
    accountId = query.accountId
    mailboxId = query.mailboxId
    mailboxRole = query.mailboxRole
    labelId = query.labelId
    filterId = query.filterId
    self.query = query.q.trimmingCharacters(in: .whitespacesAndNewlines)
    unreadOnly = query.unreadOnly
  }
}

@MainActor
@Observable
final class AppModel {
  var accounts: [MailAccount] = []
  var profile: UserProfile?
  var mailboxes: [Mailbox] = [] {
    didSet {
      PushNotificationController.shared.setApplicationBadgeCount(globalUnreadCount)
    }
  }
  var labels: [MailLabel] = []
  var filters: [MailFilter] = []
  var emails: [EmailSummary] = []
  var selectedEmail: EmailDetail?
  var conversationEmails: [EmailDetail] = []
  var selectedEmailID: String?
  var selectedEmailLoadErrorMessage: String?
  var selectedAccountID: String?
  var selectedMailboxID: String?
  var selectedLabelID: String?
  var selectedFilterID: String?
  var selectedGlobalFolder: GlobalMailboxFolder?
  var selectedUnreadOnly = false
  var searchText: String = ""
  var isLoading = false
  var isLoadingEmails = false
  var isLoadingMoreEmails = false
  var hasMoreEmails = false
  var isRefreshingMail = false
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
  var archivingEmailIDs: Set<String> = []
  var pendingArchive: PendingArchiveNotification?
  var inboxTriage: InboxTriageResult?
  var isLoadingInboxTriage = false
  var inboxTriageErrorMessage: String?

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

  var showsGlobalFoldersSection: Bool {
    didSet {
      UserDefaults.standard.set(showsGlobalFoldersSection, forKey: Defaults.showsGlobalFoldersSection)
      guard !showsGlobalFoldersSection, selectedGlobalFolder != nil else { return }
      Task { await selectGlobalInbox() }
    }
  }

  var showsIOSRefreshButton: Bool {
    didSet {
      UserDefaults.standard.set(showsIOSRefreshButton, forKey: Defaults.showsIOSRefreshButton)
    }
  }

  var visibleGlobalFolders: [GlobalMailboxFolder] {
    didSet {
      Defaults.saveVisibleGlobalFolders(visibleGlobalFolders)
    }
  }

  private var hasBootstrapped = false
  @ObservationIgnored private var pendingArchiveTask: Task<Void, Never>?
  @ObservationIgnored private var sidebarCountsRefreshTask: Task<Void, Never>?
  @ObservationIgnored private var isAutoPollingMail = false
  @ObservationIgnored private var emailListCache: [EmailListCacheKey: [EmailSummary]] = [:]
  @ObservationIgnored private var emailDetailCache: [String: EmailDetail] = [:]
  @ObservationIgnored private var emailThreadCache: [String: [EmailDetail]] = [:]
  @ObservationIgnored private var emailDetailCacheOrder: [String] = []
  @ObservationIgnored private var emailDetailPrefetchTask: Task<Void, Never>?
  @ObservationIgnored private var prefetchingEmailIDs: Set<String> = []
  @ObservationIgnored private var activeEmailQuery: EmailQuery?
  @ObservationIgnored private var nextEmailOffset = 0
  @ObservationIgnored private var emailListLoadGeneration = 0
  @ObservationIgnored private var markingReadEmailIDs: Set<String> = []
  @ObservationIgnored private var notificationSelectedEmailID: String?
  @ObservationIgnored private var inboxTriagePrefetchTask: Task<Void, Never>?
  @ObservationIgnored private let initialEmailPageSize = 30
  @ObservationIgnored private let nextEmailPageSize = 80
  @ObservationIgnored private let maxEmailDetailCacheSize = 120
  @ObservationIgnored private let emailDetailPrefetchWindow = 5

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
    showsGlobalFoldersSection = Defaults.loadShowsGlobalFoldersSection()
    showsIOSRefreshButton = Defaults.loadShowsIOSRefreshButton()
    visibleGlobalFolders = Defaults.loadVisibleGlobalFolders()
  }

  var colorScheme: ColorScheme? {
    themePreference.colorScheme
  }

  var archiveUndoDurationRange: ClosedRange<Int> {
    Defaults.archiveUndoDurationRange
  }

  var navigationTitle: String {
    if selectedUnreadOnly {
      if let selectedAccountID,
         let account = accounts.first(where: { $0.id == selectedAccountID }) {
        return "\(account.displayName) Unread"
      }
      return "Unread"
    }
    if let filter = filters.first(where: { $0.id == selectedFilterID }) {
      return filter.name
    }
    if let label = labels.first(where: { $0.id == selectedLabelID }) {
      return label.name
    }
    if let mailbox = mailboxes.first(where: { $0.id == selectedMailboxID }) {
      return mailbox.name
    }
    if let selectedGlobalFolder {
      return selectedGlobalFolder.title
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

  var canTriageCurrentInbox: Bool {
    if selectedLabelID != nil || selectedFilterID != nil {
      return false
    }
    if selectedGlobalFolder != nil {
      return false
    }
    if let selectedMailboxID,
       let mailbox = mailboxes.first(where: { $0.id == selectedMailboxID }) {
      return mailbox.role == "inbox"
    }
    return true
  }

  var isArchiving: Bool {
    guard let selectedEmailID else { return false }
    return pendingArchive?.id == selectedEmailID || archivingEmailIDs.contains(selectedEmailID)
  }

  var currentInboxUnreadCount: Int {
    guard canTriageCurrentInbox else { return 0 }

    if let selectedMailboxID,
       let mailbox = mailboxes.first(where: { $0.id == selectedMailboxID }) {
      return mailbox.role == "inbox" ? mailbox.unreadCount : 0
    }

    if let selectedAccountID {
      return mailboxes
        .filter { $0.accountId == selectedAccountID && $0.role == "inbox" }
        .reduce(0) { $0 + $1.unreadCount }
    }

    return globalUnreadCount
  }

  var enabledGlobalFolders: [GlobalMailboxFolder] {
    guard showsGlobalFoldersSection else { return [] }
    let visible = Set(visibleGlobalFolders)
    return GlobalMailboxFolder.allCases.filter { visible.contains($0) }
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
    await PushNotificationController.shared.registerCurrentDeviceTokenIfAvailable()
  }

  func refreshAll(reportErrors: Bool = true, refreshSelectedFilterCache: Bool = false) async {
    isLoading = true
    defer { isLoading = false }

    do {
      try await loadAllResources(refreshSelectedFilterCache: refreshSelectedFilterCache)
    } catch {
      if await recoverWithDefaultServer(refreshSelectedFilterCache: refreshSelectedFilterCache) {
        return
      }
      if reportErrors {
        reportError(error)
      }
    }
  }

  private func loadAllResources(refreshSelectedFilterCache: Bool = false) async throws {
    health = try await apiClient.health()
    authSettings = try? await apiClient.authSettings()
    profile = try? await apiClient.profile()
    accounts = try await apiClient.accounts()
    mailboxes = try await apiClient.mailboxes()
    labels = try await apiClient.labels()
    filters = try await apiClient.filters()
    try await loadEmails(refreshFilterCache: refreshSelectedFilterCache && selectedFilterID != nil)
    prefetchInboxTriageIfNeeded()
    errorMessage = nil
  }

  private func recoverWithDefaultServer(refreshSelectedFilterCache: Bool = false) async -> Bool {
    let currentURL = Defaults.normalizedServerURLString(serverURLString)
    let defaultURL = Defaults.normalizedServerURLString(Defaults.defaultServerURL)
    guard currentURL != defaultURL else { return false }

    serverURLString = defaultURL
    do {
      try await loadAllResources(refreshSelectedFilterCache: refreshSelectedFilterCache)
      return true
    } catch {
      return false
    }
  }

  private func loadEmails(refreshFilterCache: Bool = false) async throws {
    let query = EmailQuery(
      accountId: selectedAccountID,
      mailboxId: selectedMailboxID,
      mailboxRole: selectedGlobalFolder?.rawValue ?? defaultMailboxRole,
      labelId: selectedLabelID,
      filterId: selectedFilterID,
      q: searchText,
      unreadOnly: selectedUnreadOnly,
      refreshFilterCache: refreshFilterCache
    )
    try await loadInitialEmailPage(query: query)
  }

  private func loadInitialEmailPage(query: EmailQuery) async throws {
    emailListLoadGeneration += 1
    let generation = emailListLoadGeneration
    let cacheKey = EmailListCacheKey(query: query)
    activeEmailQuery = query
    nextEmailOffset = 0
    hasMoreEmails = false
    isLoadingMoreEmails = false

    if let cachedEmails = emailListCache[cacheKey] {
      emails = visibleEmails(cachedEmails)
      reconcileSelectedEmailWithVisibleList()
    } else {
      emails = []
      if selectedEmailID != notificationSelectedEmailID {
        selectedEmailID = nil
        selectedEmail = nil
        selectedEmailLoadErrorMessage = nil
        conversationEmails = []
      }
    }

    isLoadingEmails = true
    defer {
      if generation == emailListLoadGeneration {
        isLoadingEmails = false
      }
    }

    var pageQuery = query
    pageQuery.limit = initialEmailPageSize
    pageQuery.offset = 0

    let page: [EmailSummary]
    do {
      page = try await apiClient.emails(query: pageQuery)
    } catch {
      if generation != emailListLoadGeneration || isCancellationError(error) {
        return
      }
      throw error
    }

    guard generation == emailListLoadGeneration else { return }
    let visiblePage = visibleEmails(page)
    emails = visiblePage
    emailListCache[cacheKey] = Array(visiblePage.prefix(initialEmailPageSize))
    nextEmailOffset = page.count
    hasMoreEmails = page.count == initialEmailPageSize
    reconcileSelectedEmailWithVisibleList()
  }

  func loadMoreEmailsIfNeeded(current email: EmailSummary? = nil) {
    guard hasMoreEmails, !isLoadingEmails, !isLoadingMoreEmails else { return }
    if let email,
       let index = emails.firstIndex(where: { $0.id == email.id }),
       index < max(emails.count - 8, 0) {
      return
    }
    guard var query = activeEmailQuery else { return }
    let generation = emailListLoadGeneration
    query.limit = nextEmailPageSize
    query.offset = nextEmailOffset
    query.refreshFilterCache = false
    isLoadingMoreEmails = true

    Task {
      do {
        let page = try await apiClient.emails(query: query)
        guard generation == emailListLoadGeneration else { return }
        appendEmailPage(page)
      } catch {
        guard generation == emailListLoadGeneration else { return }
        if !Self.isTimeoutError(error) {
          reportError(error)
        }
      }
      if generation == emailListLoadGeneration {
        isLoadingMoreEmails = false
      }
    }
  }

  private func appendEmailPage(_ page: [EmailSummary]) {
    let visiblePage = visibleEmails(page)
    let existingIDs = Set(emails.map(\.id))
    emails.append(contentsOf: visiblePage.filter { !existingIDs.contains($0.id) })
    nextEmailOffset += page.count
    hasMoreEmails = page.count == nextEmailPageSize
  }

  private func visibleEmails(_ summaries: [EmailSummary]) -> [EmailSummary] {
    let pendingArchiveID = pendingArchive?.id
    return summaries.filter { $0.id != pendingArchiveID }
  }

  private func reconcileSelectedEmailWithVisibleList() {
    if selectedEmailID == notificationSelectedEmailID {
      return
    }
    if let selectedEmailID, emails.contains(where: { $0.id == selectedEmailID }) {
      return
    }
    selectedEmailID = nil
    selectedEmail = nil
    selectedEmailLoadErrorMessage = nil
    conversationEmails = []
  }

  private func clearSearchForNavigation() {
    let trimmedSearch = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedSearch.isEmpty || isSearchPresented else { return }
    searchText = ""
    isSearchPresented = false
  }

  private func refreshSidebarCounts() async throws {
    mailboxes = try await apiClient.mailboxes()
    filters = try await apiClient.filters()
  }

  private func reportError(_ error: Error) {
    guard let message = errorDescriptionForReporting(error) else { return }
    errorMessage = message
  }

  private func errorDescriptionForReporting(_ error: Error) -> String? {
    guard !isCancellationError(error) else { return nil }
    guard !Self.isTimeoutError(error) else { return nil }
    return error.localizedDescription
  }

  private func isCancellationError(_ error: Error) -> Bool {
    if Task.isCancelled || error is CancellationError {
      return true
    }

    let nsError = error as NSError
    if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled {
      return true
    }

    if let underlyingError = nsError.userInfo[NSUnderlyingErrorKey] as? NSError,
       underlyingError.domain == NSURLErrorDomain,
       underlyingError.code == NSURLErrorCancelled {
      return true
    }

    return false
  }

  private nonisolated static func isTimeoutError(_ error: Error) -> Bool {
    let nsError = error as NSError
    if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorTimedOut {
      return true
    }

    if let underlyingError = nsError.userInfo[NSUnderlyingErrorKey] as? NSError,
       underlyingError.domain == NSURLErrorDomain,
       underlyingError.code == NSURLErrorTimedOut {
      return true
    }

    return false
  }

  func refreshEmails(refreshFilterCache: Bool = false) async {
    do {
      try await loadEmails(refreshFilterCache: refreshFilterCache)
      if refreshFilterCache {
        filters = try await apiClient.filters()
      }
      prefetchInboxTriageIfNeeded()
    } catch {
      reportError(error)
    }
  }

  func loadInboxTriage(force: Bool = false) async {
    guard !isLoadingInboxTriage else { return }
    let accountID = inboxTriageAccountIDForCurrentScope
    if inboxTriage?.scope.accountId != accountID {
      inboxTriage = nil
    }
    isLoadingInboxTriage = true
    inboxTriageErrorMessage = nil
    defer { isLoadingInboxTriage = false }

    do {
      inboxTriage = try await apiClient.inboxTriage(
        accountId: accountID,
        force: force,
        limit: 50
      )
      errorMessage = nil
    } catch {
      inboxTriageErrorMessage = error.localizedDescription
    }
  }

  func prefetchInboxTriageIfNeeded() {
    guard globalUnreadCount >= 10, inboxTriagePrefetchTask == nil else { return }
    let client = apiClient
    inboxTriagePrefetchTask = Task { @MainActor in
      defer { inboxTriagePrefetchTask = nil }
      do {
        let result = try await client.inboxTriage(accountId: nil, force: false, limit: 50)
        if inboxTriage?.id == nil {
          inboxTriage = result
        }
      } catch {
        // Prefetch is opportunistic; the explicit button will surface errors.
      }
    }
  }

  func refreshVisibleMail() async {
    guard !isRefreshingMail else { return }
    isRefreshingMail = true
    let accountIds = visibleAccountIDsForRefresh()
    defer {
      isRefreshingMail = false
      syncingAccountID = nil
    }

    if accountIds.isEmpty {
      do {
        try await reloadVisibleMailAfterSync(refreshFilterCache: selectedFilterID != nil)
      } catch {
        reportError(error)
      }
      return
    }

    syncingAccountID = accountIds.count == 1 ? accountIds.first : nil
    let syncErrors = await quickSyncAccounts(accountIds)

    if syncErrors.first != nil {
      errorMessage = nil
      statusMessage = "Mail refresh is continuing"
    } else {
      errorMessage = nil
      statusMessage = "Mail refreshed"
    }

    do {
      try await reloadVisibleMailAfterSync(refreshFilterCache: selectedFilterID != nil)
    } catch {
      if syncErrors.isEmpty {
        reportError(error)
      }
    }
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
        let result = try await apiClient.syncAccount(id: accountID, limit: 10, quick: true)
        newEmailIDs.append(contentsOf: result.newEmailIds ?? [])
      } catch {
        continue
      }
    }

    await refreshAll(reportErrors: false)
    return uniqueEmailIDs(newEmailIDs)
  }

  private func reloadVisibleMailAfterSync(refreshFilterCache: Bool = false) async throws {
    mailboxes = try await apiClient.mailboxes()
    try await loadEmails(refreshFilterCache: refreshFilterCache)
    filters = try await apiClient.filters()
    prefetchInboxTriageIfNeeded()
  }

  private func quickSyncAccounts(_ accountIds: [String]) async -> [String] {
    let client = apiClient
    return await withTaskGroup(of: String?.self) { group in
      for accountId in accountIds {
        group.addTask {
          do {
            _ = try await client.syncAccount(id: accountId, limit: 10, quick: true)
            return nil
          } catch {
            if Self.isTimeoutError(error) {
              return nil
            }
            return error.localizedDescription
          }
        }
      }

      var errors: [String] = []
      for await error in group {
        if let error {
          errors.append(error)
        }
      }
      return errors
    }
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

  func checkHealth() async {
    do {
      health = try await apiClient.health()
      errorMessage = nil
    } catch {
      if await recoverWithDefaultServer() {
        return
      }
      reportError(error)
    }
  }

  func selectGlobalInbox() async {
    clearNotificationSelectionPin()
    clearSearchForNavigation()
    selectedAccountID = nil
    selectedMailboxID = nil
    selectedLabelID = nil
    selectedFilterID = nil
    selectedGlobalFolder = nil
    selectedUnreadOnly = false
    await refreshEmails()
  }

  func selectUnreadInbox(accountID: String? = nil) async {
    clearNotificationSelectionPin()
    clearSearchForNavigation()
    selectedAccountID = accountID
    selectedMailboxID = nil
    selectedLabelID = nil
    selectedFilterID = nil
    selectedGlobalFolder = nil
    selectedUnreadOnly = true
    await refreshEmails()
  }

  func selectGlobalFolder(_ folder: GlobalMailboxFolder) async {
    clearNotificationSelectionPin()
    clearSearchForNavigation()
    selectedAccountID = nil
    selectedMailboxID = nil
    selectedLabelID = nil
    selectedFilterID = nil
    selectedGlobalFolder = folder
    selectedUnreadOnly = false
    await refreshEmails()
  }

  func selectAccount(_ account: MailAccount) async {
    clearNotificationSelectionPin()
    clearSearchForNavigation()
    selectedAccountID = account.id
    selectedMailboxID = nil
    selectedLabelID = nil
    selectedFilterID = nil
    selectedGlobalFolder = nil
    selectedUnreadOnly = false
    await refreshEmails()
  }

  func selectMailbox(_ mailbox: Mailbox) async {
    clearNotificationSelectionPin()
    clearSearchForNavigation()
    selectedAccountID = mailbox.accountId
    selectedMailboxID = mailbox.id
    selectedLabelID = nil
    selectedFilterID = nil
    selectedGlobalFolder = nil
    selectedUnreadOnly = false
    await refreshEmails()
  }

  func selectLabel(_ label: MailLabel) async {
    clearNotificationSelectionPin()
    clearSearchForNavigation()
    selectedAccountID = label.accountId ?? selectedAccountID
    selectedMailboxID = nil
    selectedLabelID = label.id
    selectedFilterID = nil
    selectedGlobalFolder = nil
    selectedUnreadOnly = false
    await refreshEmails()
  }

  func selectFilter(_ filter: MailFilter) async {
    clearNotificationSelectionPin()
    clearSearchForNavigation()
    selectedAccountID = nil
    selectedMailboxID = nil
    selectedLabelID = nil
    selectedFilterID = filter.id
    selectedGlobalFolder = nil
    selectedUnreadOnly = false
    await refreshEmails(refreshFilterCache: true)
  }

  func createGlobalLabel(name: String, color: String, icon: String) async {
    do {
      let label = try await apiClient.createLabel(name: name, color: color, icon: icon)
      labels = try await apiClient.labels()
      await selectLabel(label)
    } catch {
      reportError(error)
    }
  }

  func updateLabel(_ label: MailLabel, name: String, color: String, icon: String) async {
    do {
      let updated = try await apiClient.updateLabel(id: label.id, name: name, color: color, icon: icon)
      labels = labels.map { $0.id == updated.id ? updated : $0 }
      try await loadEmails()
    } catch {
      reportError(error)
    }
  }

  func createFilter(naturalLanguage: String) async {
    do {
      let filter = try await apiClient.createFilter(naturalLanguage: naturalLanguage)
      filters = try await apiClient.filters()
      await selectFilter(filter)
    } catch {
      reportError(error)
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
      reportError(error)
    }
  }

  func moveAccounts(from source: IndexSet, to destination: Int) {
    let previousAccounts = accounts
    accounts.move(fromOffsets: source, toOffset: destination)
    persistAccountOrder(rollback: previousAccounts)
  }

  func moveAccount(id: String, before targetID: String) {
    guard let sourceIndex = accounts.firstIndex(where: { $0.id == id }),
          let targetIndex = accounts.firstIndex(where: { $0.id == targetID }),
          sourceIndex != targetIndex
    else { return }

    let account = accounts.remove(at: sourceIndex)
    let adjustedTargetIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex
    accounts.insert(account, at: adjustedTargetIndex)
  }

  func persistAccountOrder() {
    persistAccountOrder(rollback: accounts)
  }

  private func persistAccountOrder(rollback previousAccounts: [MailAccount]) {
    let orderedIds = accounts.map(\.id)
    Task {
      do {
        accounts = try await apiClient.reorderAccounts(ids: orderedIds)
        profile = try? await apiClient.profile()
        mailboxes = try await apiClient.mailboxes()
        errorMessage = nil
      } catch {
        accounts = previousAccounts
        reportError(error)
      }
    }
  }

  func moveFilters(from source: IndexSet, to destination: Int) {
    let previousFilters = filters
    filters.move(fromOffsets: source, toOffset: destination)
    persistFilterOrder(rollback: previousFilters)
  }

  func moveFilter(id: String, before targetID: String) {
    guard let sourceIndex = filters.firstIndex(where: { $0.id == id }),
          let targetIndex = filters.firstIndex(where: { $0.id == targetID }),
          sourceIndex != targetIndex
    else { return }

    let filter = filters.remove(at: sourceIndex)
    let adjustedTargetIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex
    filters.insert(filter, at: adjustedTargetIndex)
  }

  func persistFilterOrder() {
    persistFilterOrder(rollback: filters)
  }

  private func persistFilterOrder(rollback previousFilters: [MailFilter]) {
    let orderedIds = filters.map(\.id)
    Task {
      do {
        filters = try await apiClient.reorderFilters(ids: orderedIds)
        errorMessage = nil
      } catch {
        filters = previousFilters
        reportError(error)
      }
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
        selectedEmailLoadErrorMessage = nil
        conversationEmails = []
        try await loadEmails()
      }
      statusMessage = "Filter deleted"
      errorMessage = nil
    } catch {
      reportError(error)
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
    if notificationSelectedEmailID != id {
      clearNotificationSelectionPin()
    }
    selectedEmailID = id
    selectedEmailLoadErrorMessage = nil
    prefetchNearbyEmailDetails(after: id)
    if selectedEmail?.id != id {
      if let cachedEmail = emailDetailCache[id] {
        selectedEmail = cachedEmail
        conversationEmails = emailThreadCache[id] ?? [cachedEmail]
      } else {
        selectedEmail = nil
        conversationEmails = []
      }
    }
  }

  func selectEmail(id: String) async {
    beginSelectingEmail(id: id)
    do {
      let detail = try await apiClient.email(id: id)
      guard selectedEmailID == id else { return }

      if !detail.isRead {
        markVisibleEmail(id: detail.id, isRead: true)
      }

      cacheEmailDetail(detail)
      selectedEmailLoadErrorMessage = nil
      selectedEmail = detail
      conversationEmails = emailThreadCache[id] ?? [detail]

      if !detail.isRead {
        markEmailReadInBackground(detail)
      }

      do {
        let thread = try await apiClient.thread(emailId: detail.id)
        guard selectedEmailID == id else { return }
        cacheConversation(anchorID: id, thread)
        conversationEmails = thread
      } catch {
        guard selectedEmailID == id else { return }
        conversationEmails = emailThreadCache[id] ?? [detail]
      }
    } catch {
      guard selectedEmailID == id else { return }
      if let cachedEmail = emailDetailCache[id] {
        selectedEmailLoadErrorMessage = nil
        selectedEmail = cachedEmail
        conversationEmails = emailThreadCache[id] ?? [cachedEmail]
        return
      }
      selectedEmailLoadErrorMessage = errorDescriptionForReporting(error) ?? "Message took too long to load."
      selectedEmail = nil
      conversationEmails = []
    }
  }

  func openEmailFromNotification(id: String) async {
    clearSearchForNavigation()
    notificationSelectedEmailID = id
    beginSelectingEmail(id: id)
    notificationNavigationRequestCount += 1
    if selectedEmailID == id {
      await selectEmail(id: id)
    }
  }

  private func markEmailReadInBackground(_ email: EmailDetail) {
    guard !markingReadEmailIDs.contains(email.id) else { return }
    markingReadEmailIDs.insert(email.id)

    Task { @MainActor in
      defer { markingReadEmailIDs.remove(email.id) }

      do {
        let updated = try await apiClient.updateEmail(id: email.id, isRead: true)
        cacheEmailDetail(updated)
        markVisibleEmail(id: updated.id, isRead: true)
        try? await refreshSidebarCounts()

        guard selectedEmailID == updated.id else { return }
        if selectedEmail?.id == updated.id, selectedEmail?.isRead == false {
          selectedEmail = updated
        }
        conversationEmails = conversationEmails.map { message in
          message.id == updated.id ? updated : message
        }
      } catch {
        return
      }
    }
  }

  private func markVisibleEmail(id: String, isRead: Bool) {
    if let index = emails.firstIndex(where: { $0.id == id }) {
      emails[index].isRead = isRead
    }

    for key in Array(emailListCache.keys) {
      guard let index = emailListCache[key]?.firstIndex(where: { $0.id == id }) else { continue }
      emailListCache[key]?[index].isRead = isRead
    }
  }

  private func cacheEmailDetail(_ email: EmailDetail) {
    emailDetailCache[email.id] = email
    emailDetailCacheOrder.removeAll { $0 == email.id }
    emailDetailCacheOrder.append(email.id)
    trimEmailDetailCache()
  }

  private func cacheConversation(anchorID: String, _ emails: [EmailDetail]) {
    guard !emails.isEmpty else { return }
    for email in emails {
      cacheEmailDetail(email)
    }
    for email in emails {
      emailThreadCache[email.id] = emails
    }
    emailThreadCache[anchorID] = emails
    trimEmailDetailCache()
  }

  private func trimEmailDetailCache() {
    while emailDetailCacheOrder.count > maxEmailDetailCacheSize, let oldestID = emailDetailCacheOrder.first {
      emailDetailCacheOrder.removeFirst()
      emailDetailCache.removeValue(forKey: oldestID)
      emailThreadCache.removeValue(forKey: oldestID)
    }
  }

  private func prefetchNearbyEmailDetails(after id: String) {
    let ids = nearbyEmailIDs(around: id, limit: emailDetailPrefetchWindow)
    emailDetailPrefetchTask?.cancel()
    guard !ids.isEmpty else {
      emailDetailPrefetchTask = nil
      return
    }

    let client = apiClient
    emailDetailPrefetchTask = Task { @MainActor in
      defer {
        if !Task.isCancelled {
          emailDetailPrefetchTask = nil
        }
      }

      for id in ids {
        guard !Task.isCancelled else { return }
        await prefetchEmailDetail(id: id, client: client)
      }
    }
  }

  private func nearbyEmailIDs(around id: String, limit: Int) -> [String] {
    guard limit > 0,
          let selectedIndex = emails.firstIndex(where: { $0.id == id })
    else { return [] }

    let following = emails.dropFirst(selectedIndex + 1)
    let previous = emails.prefix(selectedIndex).reversed()
    let candidates = Array(following) + Array(previous)
    return candidates
      .map(\.id)
      .filter { candidateID in
        candidateID != id &&
          candidateID != pendingArchive?.id &&
          !archivingEmailIDs.contains(candidateID) &&
          emailDetailCache[candidateID] == nil &&
          !prefetchingEmailIDs.contains(candidateID)
      }
      .prefix(limit)
      .map { $0 }
  }

  private func prefetchEmailDetail(id: String, client: MailAPIClient) async {
    guard emailDetailCache[id] == nil,
          !prefetchingEmailIDs.contains(id)
    else { return }

    prefetchingEmailIDs.insert(id)
    defer { prefetchingEmailIDs.remove(id) }

    do {
      let detail = try await client.email(id: id)
      guard !Task.isCancelled else { return }
      cacheEmailDetail(detail)

      guard !Task.isCancelled else { return }
      if let thread = try? await client.thread(emailId: detail.id) {
        guard !Task.isCancelled else { return }
        cacheConversation(anchorID: id, thread)
      }
    } catch {
      return
    }
  }

  private func clearNotificationSelectionPin() {
    notificationSelectedEmailID = nil
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
      reportError(error)
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
      reportError(error)
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
      reportError(error)
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
      reportError(error)
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
      reportError(error)
      return false
    }
  }

  func send(_ request: SendMessageRequest) async -> Bool {
    isSending = true
    defer { isSending = false }

    do {
      let response = try await apiClient.send(request)
      cacheEmailDetail(response.email)
      selectedEmailID = response.email.id
      selectedEmail = response.email
      let thread = (try? await apiClient.thread(emailId: response.email.id)) ?? [response.email]
      cacheConversation(anchorID: response.email.id, thread)
      conversationEmails = thread
      await refreshAll()
      return true
    } catch {
      reportError(error)
      return false
    }
  }

  func recipientSuggestions(matching query: String) async -> [RecipientSuggestion] {
    let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmedQuery.count >= 2 else { return [] }

    do {
      return try await apiClient.recipientSuggestions(query: trimmedQuery)
    } catch {
      return []
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

  func isGlobalFolderVisible(_ folder: GlobalMailboxFolder) -> Bool {
    visibleGlobalFolders.contains(folder)
  }

  func setGlobalFolder(_ folder: GlobalMailboxFolder, isVisible: Bool) {
    var visible = Set(visibleGlobalFolders)
    if isVisible {
      visible.insert(folder)
    } else {
      visible.remove(folder)
    }

    visibleGlobalFolders = GlobalMailboxFolder.allCases.filter { visible.contains($0) }

    if !isVisible, selectedGlobalFolder == folder {
      Task { await selectGlobalInbox() }
    }
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
    guard let selectedEmailID, !isEmailArchiving(selectedEmailID) else { return }
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
      try await refreshSidebarCounts()
      try await loadEmails()
    } catch {
      reportError(error)
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
    guard pendingArchive?.id != id, !archivingEmailIDs.contains(id) else { return }

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
      withAnimation(.easeOut(duration: 0.20)) {
        emails.removeAll { $0.id == id }
        if selectedEmailID == id {
          selectedEmailID = replacementSelectedEmailID
          selectedEmail = nil
          selectedEmailLoadErrorMessage = nil
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
    guard archivingEmailIDs.insert(archive.id).inserted else { return }
    defer { archivingEmailIDs.remove(archive.id) }

    let updated: EmailDetail
    do {
      updated = try await apiClient.archiveEmail(emailId: archive.id)
      statusMessage = "Archived"
      errorMessage = nil
      if archive.removedFromCurrentList {
        cacheEmailDetail(updated)
        removeEmailFromListCaches(id: archive.id)
      } else {
        applyEmailUpdate(updated)
      }
    } catch {
      if archive.removedFromCurrentList {
        withAnimation(.snappy(duration: 0.24)) {
          emails = archive.previousEmails
          selectedEmailID = archive.previousSelectedEmailID
          selectedEmail = archive.previousSelectedEmail
          conversationEmails = archive.previousConversationEmails
        }
      }
      reportError(error)
      return
    }

    scheduleSidebarCountsRefresh()
  }

  private func isEmailArchiving(_ id: String) -> Bool {
    pendingArchive?.id == id || archivingEmailIDs.contains(id)
  }

  private func trashEmail(id: String) async {
    do {
      let updated = try await apiClient.trashEmail(emailId: id)
      statusMessage = "Moved to Trash"
      errorMessage = nil
      applyEmailUpdate(updated)
      try await refreshSidebarCounts()
      try await loadEmails()
    } catch {
      reportError(error)
    }
  }

  private func markSpam(id: String) async {
    do {
      let updated = try await apiClient.markSpam(emailId: id)
      statusMessage = "Moved to Spam"
      errorMessage = nil
      applyEmailUpdate(updated)
      try await refreshSidebarCounts()
      try await loadEmails()
    } catch {
      reportError(error)
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
      let updated = try await apiClient.setLabel(emailId: selectedEmail.id, labelId: label.id, action: action)
      applyEmailUpdate(updated)
      try await loadEmails()
    } catch {
      reportError(error)
    }
  }

  func moveSelectedEmail(to mailbox: Mailbox) async {
    guard let selectedEmail else { return }
    do {
      let updated = try await apiClient.updateEmail(id: selectedEmail.id, mailboxId: mailbox.id)
      applyEmailUpdate(updated)
      await refreshAll()
    } catch {
      reportError(error)
    }
  }

  func markSelectedSpam() async {
    guard let selectedEmail else { return }
    do {
      let updated = try await apiClient.markSpam(emailId: selectedEmail.id)
      applyEmailUpdate(updated)
      statusMessage = "Moved to Spam"
      errorMessage = nil
      await refreshAll()
    } catch {
      reportError(error)
    }
  }

  func blockSelectedSender(scope: BlockSenderScope) async {
    guard let selectedEmail else { return }
    do {
      let result = try await apiClient.blockSender(emailId: selectedEmail.id, scope: scope)
      applyEmailUpdate(result.email)
      statusMessage = blockStatusMessage(scope: result.rule.scope, value: result.rule.value, affectedCount: result.affectedCount)
      errorMessage = nil
      await refreshAll()
    } catch {
      reportError(error)
    }
  }

  private func updateSelectedEmail(isRead: Bool?, isStarred: Bool?) async {
    guard let selectedEmail else { return }
    do {
      let updated = try await apiClient.updateEmail(id: selectedEmail.id, isRead: isRead, isStarred: isStarred)
      applyEmailUpdate(updated)
      if isRead != nil {
        try await refreshSidebarCounts()
      }
      try await loadEmails()
    } catch {
      reportError(error)
    }
  }

  private func blockStatusMessage(scope: BlockSenderScope, value: String, affectedCount: Int) -> String {
    let target = scope == .domain ? value : value
    let messageCount = affectedCount == 1 ? "1 message" : "\(affectedCount) messages"
    return "Blocked \(target). Moved \(messageCount) to Blocked."
  }

  private func applyEmailUpdate(_ email: EmailDetail) {
    cacheEmailDetail(email)
    if selectedEmailID == email.id {
      selectedEmail = email
    }
    conversationEmails = conversationEmails.map { message in
      message.id == email.id ? email : message
    }
    for key in Array(emailThreadCache.keys) {
      guard emailThreadCache[key]?.contains(where: { $0.id == email.id }) == true else { continue }
      emailThreadCache[key] = emailThreadCache[key]?.map { message in
        message.id == email.id ? email : message
      }
    }
  }

  private func removeEmailFromListCaches(id: String) {
    for key in Array(emailListCache.keys) {
      emailListCache[key]?.removeAll { $0.id == id }
    }
  }

  private func scheduleSidebarCountsRefresh() {
    sidebarCountsRefreshTask?.cancel()
    sidebarCountsRefreshTask = Task { @MainActor in
      do {
        try await Task.sleep(for: .milliseconds(700))
      } catch {
        return
      }
      guard !Task.isCancelled else { return }
      try? await refreshSidebarCounts()
      guard !Task.isCancelled else { return }
      sidebarCountsRefreshTask = nil
    }
  }

  private var defaultMailboxRole: String? {
    if selectedGlobalFolder != nil {
      return nil
    }
    if shouldLoadCompleteEmailResultSet {
      return nil
    }
    return selectedMailboxID == nil && selectedLabelID == nil ? "inbox" : nil
  }

  private var inboxTriageAccountIDForCurrentScope: String? {
    if let selectedAccountID {
      return selectedAccountID
    }
    if let selectedMailboxID,
       let mailbox = mailboxes.first(where: { $0.id == selectedMailboxID }) {
      return mailbox.accountId
    }
    return nil
  }

  private var shouldLoadCompleteEmailResultSet: Bool {
    selectedFilterID != nil || !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  private func shouldRemoveArchivedEmailFromCurrentList(emailId: String) -> Bool {
    guard emails.contains(where: { $0.id == emailId }) else {
      return false
    }

    if let selectedMailboxID,
       let mailbox = mailboxes.first(where: { $0.id == selectedMailboxID }) {
      return mailbox.role == "inbox"
    }

    if let selectedGlobalFolder {
      return selectedGlobalFolder != .archive
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
  static let showsGlobalFoldersSection = "email.sidebar.showsGlobalFoldersSection"
  static let showsIOSRefreshButton = "email.ios.showsRefreshButton"
  static let visibleGlobalFolderRoles = "email.sidebar.visibleGlobalFolderRoles"
  static let visibleGlobalFolderRolesVersion = "email.sidebar.visibleGlobalFolderRoles.version"
  static let currentVisibleGlobalFolderRolesVersion = 2
  static let defaultArchiveUndoDurationSeconds = 4
  static let archiveUndoDurationRange = 1...15

  static var defaultServerURL: String {
    Bundle.main.object(forInfoDictionaryKey: "EmailDefaultServerURL") as? String ?? "https://space.tailb90a7f.ts.net:8443"
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

  static func loadShowsGlobalFoldersSection() -> Bool {
    guard UserDefaults.standard.object(forKey: showsGlobalFoldersSection) != nil else {
      return true
    }
    return UserDefaults.standard.bool(forKey: showsGlobalFoldersSection)
  }

  static func loadShowsIOSRefreshButton() -> Bool {
    guard UserDefaults.standard.object(forKey: showsIOSRefreshButton) != nil else {
      return false
    }
    return UserDefaults.standard.bool(forKey: showsIOSRefreshButton)
  }

  static func loadVisibleGlobalFolders() -> [GlobalMailboxFolder] {
    guard UserDefaults.standard.object(forKey: visibleGlobalFolderRoles) != nil else {
      UserDefaults.standard.set(currentVisibleGlobalFolderRolesVersion, forKey: visibleGlobalFolderRolesVersion)
      return GlobalMailboxFolder.allCases
    }

    let rawValues = UserDefaults.standard.stringArray(forKey: visibleGlobalFolderRoles) ?? []
    var decoded = Set(rawValues.compactMap(GlobalMailboxFolder.init(rawValue:)))
    let version = UserDefaults.standard.integer(forKey: visibleGlobalFolderRolesVersion)
    if version < currentVisibleGlobalFolderRolesVersion {
      decoded.insert(.blocked)
      UserDefaults.standard.set(currentVisibleGlobalFolderRolesVersion, forKey: visibleGlobalFolderRolesVersion)
      let migratedRawValues = GlobalMailboxFolder.allCases
        .filter { decoded.contains($0) }
        .map(\.rawValue)
      UserDefaults.standard.set(migratedRawValues, forKey: visibleGlobalFolderRoles)
    }
    return GlobalMailboxFolder.allCases.filter { decoded.contains($0) }
  }

  static func saveVisibleGlobalFolders(_ folders: [GlobalMailboxFolder]) {
    let rawValues = GlobalMailboxFolder.allCases
      .filter { folders.contains($0) }
      .map(\.rawValue)
    UserDefaults.standard.set(rawValues, forKey: visibleGlobalFolderRoles)
    UserDefaults.standard.set(currentVisibleGlobalFolderRolesVersion, forKey: visibleGlobalFolderRolesVersion)
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
