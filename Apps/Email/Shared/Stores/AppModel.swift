import Foundation
import Observation
import SwiftUI

@MainActor
@Observable
final class AppModel {
  var accounts: [MailAccount] = []
  var mailboxes: [Mailbox] = []
  var labels: [MailLabel] = []
  var emails: [EmailSummary] = []
  var selectedEmail: EmailDetail?
  var selectedEmailID: String?
  var selectedAccountID: String?
  var selectedMailboxID: String?
  var selectedLabelID: String?
  var searchText: String = ""
  var isLoading = false
  var isSending = false
  var errorMessage: String?
  var health: HealthResponse?

  var serverURLString: String {
    didSet {
      UserDefaults.standard.set(serverURLString, forKey: Defaults.serverURL)
    }
  }

  var themePreference: ThemePreference {
    didSet {
      UserDefaults.standard.set(themePreference.rawValue, forKey: Defaults.theme)
    }
  }

  private var hasBootstrapped = false

  init() {
    serverURLString = UserDefaults.standard.string(forKey: Defaults.serverURL) ?? "http://127.0.0.1:7331"
    let rawTheme = UserDefaults.standard.string(forKey: Defaults.theme) ?? ThemePreference.system.rawValue
    themePreference = ThemePreference(rawValue: rawTheme) ?? .system
  }

  var colorScheme: ColorScheme? {
    themePreference.colorScheme
  }

  var navigationTitle: String {
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
    let fallback = URL(string: "http://127.0.0.1:7331")!
    return MailAPIClient(baseURL: URL(string: serverURLString) ?? fallback)
  }

  func bootstrap() async {
    guard !hasBootstrapped else { return }
    hasBootstrapped = true
    await refreshAll()
  }

  func refreshAll() async {
    isLoading = true
    defer { isLoading = false }

    do {
      health = try await apiClient.health()
      accounts = try await apiClient.accounts()
      mailboxes = try await apiClient.mailboxes()
      labels = try await apiClient.labels()
      try await loadEmails()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func loadEmails() async throws {
    let query = EmailQuery(
      accountId: selectedAccountID,
      mailboxId: selectedMailboxID,
      labelId: selectedLabelID,
      q: searchText
    )
    emails = try await apiClient.emails(query: query)

    if let selectedEmailID, emails.contains(where: { $0.id == selectedEmailID }) {
      selectedEmail = try? await apiClient.email(id: selectedEmailID)
    } else if selectedEmailID == nil {
      selectedEmail = nil
    }
  }

  func refreshEmails() async {
    do {
      try await loadEmails()
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
    await refreshEmails()
  }

  func selectAccount(_ account: MailAccount) async {
    selectedAccountID = account.id
    selectedMailboxID = nil
    selectedLabelID = nil
    await refreshEmails()
  }

  func selectMailbox(_ mailbox: Mailbox) async {
    selectedAccountID = mailbox.accountId
    selectedMailboxID = mailbox.id
    selectedLabelID = nil
    await refreshEmails()
  }

  func selectLabel(_ label: MailLabel) async {
    selectedAccountID = label.accountId
    selectedMailboxID = nil
    selectedLabelID = label.id
    await refreshEmails()
  }

  func selectEmail(_ summary: EmailSummary) async {
    selectedEmailID = summary.id
    do {
      var detail = try await apiClient.email(id: summary.id)
      if !detail.isRead {
        detail = try await apiClient.updateEmail(id: detail.id, isRead: true)
        await refreshAll()
      }
      selectedEmail = detail
    } catch {
      errorMessage = error.localizedDescription
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

  func send(_ request: SendMessageRequest) async -> Bool {
    isSending = true
    defer { isSending = false }

    do {
      let response = try await apiClient.send(request)
      selectedEmailID = response.email.id
      selectedEmail = response.email
      await refreshAll()
      return true
    } catch {
      errorMessage = error.localizedDescription
      return false
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

  private func updateSelectedEmail(isRead: Bool?, isStarred: Bool?) async {
    guard let selectedEmail else { return }
    do {
      self.selectedEmail = try await apiClient.updateEmail(id: selectedEmail.id, isRead: isRead, isStarred: isStarred)
      try await loadEmails()
    } catch {
      errorMessage = error.localizedDescription
    }
  }
}

private enum Defaults {
  static let serverURL = "email.serverURL"
  static let theme = "email.theme"
}
