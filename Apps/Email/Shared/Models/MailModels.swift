import Foundation
import SwiftUI

enum MailProvider: String, Codable, CaseIterable, Identifiable {
  case gmail
  case icloud
  case imap

  var id: String { rawValue }

  var displayName: String {
    switch self {
    case .gmail: "Gmail"
    case .icloud: "iCloud"
    case .imap: "IMAP"
    }
  }

  var systemImage: String {
    switch self {
    case .gmail: "envelope.circle"
    case .icloud: "icloud"
    case .imap: "server.rack"
    }
  }
}

struct MailAccount: Codable, Identifiable, Hashable {
  var id: String
  var provider: MailProvider
  var email: String
  var displayName: String
  var avatarURL: String?
  var authType: String
  var status: String
  var syncHistory: Bool
  var sortOrder: Int?
  var lastSyncAt: String?
  var providerMetadata: AccountProviderMetadata?
  var stats: AccountMailStats?
  var createdAt: String
}

struct AccountProviderMetadata: Codable, Hashable {
  var cartaSyncStatus: MailImportStatus?
}

struct AccountMailStats: Codable, Hashable {
  var totalCount: Int
  var unreadCount: Int
  var oldestReceivedAt: String?
  var newestReceivedAt: String?
  var attachmentEmailCount: Int
  var attachmentCount: Int?
  var fileAttachmentCount: Int?
  var downloadedAttachmentCount: Int?
  var messageBytes: Int?
  var attachmentBytes: Int?
  var downloadedAttachmentBytes: Int?
  var storedBytes: Int?
  var byMailbox: [AccountMailboxStats]?

  var localStorageBytes: Int {
    storedBytes ?? ((messageBytes ?? 0) + (downloadedAttachmentBytes ?? 0))
  }
}

struct AccountMailboxStats: Codable, Hashable, Identifiable {
  var role: String
  var name: String
  var totalCount: Int
  var unreadCount: Int

  var id: String { "\(role)-\(name)" }
}

struct MailImportStatus: Codable, Hashable {
  var status: String?
  var historyWindow: String?
  var includeAttachments: Bool?
  var imported: Int?
  var backfilled: Int?
  var oldestReceivedAt: String?
  var startedAt: String?
  var updatedAt: String?
  var completedAt: String?
  var error: String?

  var normalizedStatus: String {
    status?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
  }

  var isImporting: Bool {
    normalizedStatus == "running"
  }

  var isComplete: Bool {
    normalizedStatus == "complete"
  }

  var isPartial: Bool {
    normalizedStatus == "partial"
  }

  var isFailed: Bool {
    normalizedStatus == "failed"
  }

  var isFullHistory: Bool {
    historyWindow == "all"
  }

  var shouldShowInClient: Bool {
    ["running", "partial", "failed"].contains(normalizedStatus)
  }

  var title: String {
    switch normalizedStatus {
    case "failed":
      "Import needs attention"
    case "partial":
      "Import paused"
    default:
      "Importing mail"
    }
  }

  var countText: String? {
    guard let imported, imported > 0 else { return nil }
    return "\(imported.formatted()) imported"
  }

  var oldestText: String? {
    guard let oldestReceivedAt, !oldestReceivedAt.isEmpty else { return nil }
    return "oldest \(String(oldestReceivedAt.prefix(10)))"
  }

  var windowText: String? {
    guard let historyWindow, !historyWindow.isEmpty else { return nil }
    if historyWindow == "all" {
      return "full history"
    }
    return historyWindow.replacingOccurrences(of: "-", with: " ")
  }

  var attachmentText: String {
    includeAttachments == true ? "attachments downloaded" : "attachments on demand"
  }

  func detailText(account: MailAccount? = nil) -> String {
    if normalizedStatus == "failed", let error, !error.isEmpty {
      return error
    }

    var parts: [String] = []
    if let account {
      parts.append(account.displayName)
    }
    if let countText {
      parts.append(countText)
    }
    if let oldestText {
      parts.append(oldestText)
    }
    if let windowText {
      parts.append(windowText)
    }
    return parts.isEmpty ? "Messages may still be arriving." : parts.joined(separator: " - ")
  }
}

extension MailAccount {
  var importStatus: MailImportStatus? {
    providerMetadata?.cartaSyncStatus
  }

  var isImportingMail: Bool {
    importStatus?.isImporting == true
  }

  var shouldShowImportStatus: Bool {
    importStatus?.shouldShowInClient == true
  }
}

struct UserProfile: Codable, Identifiable, Hashable {
  var id: String
  var displayName: String
  var primaryEmail: String?
  var createdAt: String
  var updatedAt: String
  var accounts: [MailAccount]
}

struct Mailbox: Codable, Identifiable, Hashable {
  var id: String
  var accountId: String
  var accountEmail: String
  var name: String
  var role: String
  var unreadCount: Int
  var totalCount: Int?
}

struct MailLabel: Codable, Identifiable, Hashable {
  var id: String
  var accountId: String?
  var accountEmail: String?
  var name: String
  var color: String
  var icon: String?
  var isSystem: Bool
}

struct MailFilterCriteria: Codable, Hashable {
  var sender: String? = nil
  var subject: String? = nil
  var text: String? = nil
  var query: String? = nil
  var hasAttachments: Bool? = nil
  var attachmentKind: String? = nil
  var unread: Bool? = nil
  var starred: Bool? = nil
}

struct MailFilter: Codable, Identifiable, Hashable {
  var id: String
  var name: String
  var color: String
  var icon: String
  var naturalLanguage: String?
  var criteria: MailFilterCriteria
  var querySource: String?
  var queryError: String?
  var emailCount: Int?
  var cacheUpdatedAt: String?
  var sortOrder: Int?
  var createdAt: String
  var updatedAt: String
}

struct MailRuleApplication: Codable, Hashable {
  var ruleId: String
  var emailId: String
  var action: String
}

struct MailRule: Codable, Identifiable, Hashable {
  var id: String
  var name: String
  var action: String
  var enabled: Bool
  var naturalLanguage: String?
  var criteria: MailFilterCriteria
  var querySource: String?
  var queryError: String?
  var matchCount: Int?
  var appliedCount: Int?
  var lastAppliedAt: String?
  var sortOrder: Int?
  var createdAt: String
  var updatedAt: String
}

enum GlobalMailboxFolder: String, Codable, CaseIterable, Identifiable {
  case sent
  case drafts
  case archive
  case spam
  case blocked
  case trash

  var id: String { rawValue }

  var title: String {
    switch self {
    case .sent: "Sent"
    case .drafts: "Drafts"
    case .archive: "Archive"
    case .spam: "Spam"
    case .blocked: "Blocked"
    case .trash: "Trash"
    }
  }

  var systemImage: String {
    switch self {
    case .sent: "paperplane"
    case .drafts: "doc"
    case .archive: "archivebox"
    case .spam: "exclamationmark.octagon"
    case .blocked: "hand.raised"
    case .trash: "trash"
    }
  }
}

enum FilterMailboxScope: String, CaseIterable, Identifiable {
  case inbox
  case archive
  case spam
  case trash
  case sent
  case blocked
  case all

  var id: String { rawValue }

  var mailboxRole: String? {
    self == .all ? nil : rawValue
  }

  var title: String {
    switch self {
    case .inbox: "Inbox"
    case .archive: "Archive"
    case .spam: "Spam"
    case .trash: "Trash"
    case .sent: "Sent"
    case .blocked: "Blocked"
    case .all: "All Mail"
    }
  }

  var systemImage: String {
    switch self {
    case .inbox: "tray"
    case .archive: "archivebox"
    case .spam: "exclamationmark.octagon"
    case .trash: "trash"
    case .sent: "paperplane"
    case .blocked: "hand.raised"
    case .all: "tray.full"
    }
  }
}

struct EmailSummary: Codable, Identifiable, Hashable {
  var id: String
  var accountId: String
  var accountEmail: String
  var provider: MailProvider
  var mailboxId: String
  var mailboxName: String
  var mailboxRole: String
  var senderName: String
  var senderEmail: String
  var senderAvatarURL: String?
  var subject: String
  var snippet: String
  var receivedAt: String
  var sentAt: String
  var isRead: Bool
  var isStarred: Bool
  var importance: String
  var hasAttachments: Bool
  var trackingId: String?
  var openedAt: String?
  var labels: [MailLabel]
}

struct EmailAttachment: Codable, Identifiable, Hashable {
  var id: String
  var emailId: String
  var filename: String
  var mimeType: String
  var size: Int
  var disposition: String?
  var isInline: Bool
  var contentId: String?
  var isDownloaded: Bool
}

struct EmailDetail: Codable, Identifiable, Hashable {
  var id: String
  var accountId: String
  var accountEmail: String
  var provider: MailProvider
  var mailboxId: String
  var mailboxName: String
  var mailboxRole: String
  var providerUID: String?
  var threadId: String?
  var senderName: String
  var senderEmail: String
  var senderAvatarURL: String?
  var recipients: [String]
  var cc: [String]
  var bcc: [String]
  var subject: String
  var snippet: String
  var bodyText: String
  var bodyHTML: String?
  var rfcMessageID: String?
  var inReplyTo: String?
  var references: [String]
  var receivedAt: String
  var sentAt: String
  var isRead: Bool
  var isStarred: Bool
  var importance: String
  var hasAttachments: Bool
  var trackingId: String?
  var openedAt: String?
  var createdAt: String
  var labels: [MailLabel]
  var attachments: [EmailAttachment]?
}

struct InboxTriageResult: Codable, Identifiable, Hashable {
  var id: String
  var scope: InboxTriageScope
  var generatedAt: String
  var source: String
  var error: String?
  var isCached: Bool
  var unreadCount: Int
  var analyzedCount: Int
  var limit: Int
  var summaryBullets: [String]
  var sections: [InboxTriageSection]
}

struct InboxTriageScope: Codable, Hashable {
  var accountId: String?
  var mailboxRole: String
  var unreadOnly: Bool
}

struct InboxTriageSection: Codable, Identifiable, Hashable {
  var id: String
  var title: String
  var intent: InboxTriageIntent
  var count: Int
  var emails: [InboxTriageEmail]
}

enum InboxTriageIntent: String, Codable, Hashable {
  case read
  case archive
}

struct InboxTriageEmail: Codable, Identifiable, Hashable {
  var id: String
  var accountId: String
  var accountEmail: String
  var senderName: String
  var senderEmail: String
  var senderAvatarURL: String?
  var subject: String
  var snippet: String
  var receivedAt: String
  var intent: InboxTriageIntent
  var reason: String
  var priority: String
  var summaryBullets: [String]
}

enum BlockSenderScope: String, Codable, CaseIterable, Identifiable {
  case email
  case domain

  var id: String { rawValue }
}

struct BlockedSenderRule: Codable, Identifiable, Hashable {
  var id: String
  var accountId: String
  var accountEmail: String?
  var scope: BlockSenderScope
  var value: String
  var sourceEmailId: String?
  var createdAt: String
}

struct AddAccountRequest: Encodable {
  var provider: MailProvider
  var email: String
  var displayName: String
  var syncHistory: Bool
}

struct AuthSettings: Codable, Hashable {
  var gmailConfigured: Bool
  var gmailRedirectURI: String
  var icloudConfigured: Bool
  var icloudAuthType: String
  var appleMailOAuthAvailable: Bool
}

struct GmailAuthStartRequest: Encodable {
  var displayName: String
  var syncHistory: Bool
}

struct GmailAuthStartResponse: Decodable {
  var provider: String
  var authorizationURL: String
  var state: String
  var redirectURI: String
}

struct ICloudConnectRequest: Encodable {
  var email: String
  var username: String?
  var displayName: String
  var appPassword: String
  var syncHistory: Bool
}

struct UpdateAccountSettingsRequest: Encodable {
  var displayName: String
  var avatarURL: String
  var syncHistory: Bool
}

struct ProviderSyncResult: Codable, Hashable {
  var provider: String
  var imported: Int
  var newEmailIds: [String]?
}

struct ProviderBackfillResult: Codable, Hashable {
  var provider: String?
  var status: String?
  var imported: Int?
  var complete: Bool?
}

struct ProviderConnectResponse: Decodable {
  var account: MailAccount
  var sync: ProviderSyncResult
}

struct SyncResponse: Decodable {
  var sync: ProviderSyncResult
}

struct BackfillResponse: Decodable {
  var backfill: ProviderBackfillResult
}

struct PushTokenRegistrationRequest: Encodable {
  var token: String
  var platform: String
  var bundleId: String
  var environment: String
  var deviceName: String?
}

struct PushTokenRegistrationResponse: Decodable {
  var pushConfigured: Bool
}

struct SendMessageRequest: Encodable {
  var accountId: String
  var to: String
  var cc: String
  var bcc: String
  var subject: String
  var bodyText: String
  var bodyHTML: String?
  var trackOpens: Bool
  var replyToEmailID: String?
}

struct RecipientSuggestion: Codable, Identifiable, Hashable {
  var normalizedEmail: String
  var email: String
  var displayName: String?
  var avatarURL: String?
  var inboundCount: Int
  var outboundCount: Int
  var lastContactedAt: String

  var id: String { normalizedEmail }

  var title: String {
    let trimmedName = displayName?.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmedName?.isEmpty == false ? trimmedName! : email
  }

  var subtitle: String {
    email
  }

  var formattedAddress: String {
    let trimmedName = displayName?.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let trimmedName, !trimmedName.isEmpty, trimmedName.lowercased() != email.lowercased() else {
      return email
    }
    return "\(trimmedName) <\(email)>"
  }
}

struct ComposeDraft: Hashable {
  var accountId: String
  var to: String
  var cc: String
  var bcc: String
  var subject: String
  var bodyHTML: String
  var bodyText: String
  var replyToEmailID: String?
}

extension ComposeDraft {
  @MainActor
  static func reply(to email: EmailDetail) -> ComposeDraft {
    let quotedText = email.bodyText.trimmingCharacters(in: .whitespacesAndNewlines)
    let quotedHTML = email.bodyHTML?.trimmingCharacters(in: .whitespacesAndNewlines)
    let quote = quotedHTML?.isEmpty == false
      ? quotedHTML!
      : "<pre>\(quotedText.htmlEscapedForDraft)</pre>"
    let bodyHTML = """
    <p><br></p>
    <blockquote>
    <p>On \(MailDateFormatter.listTimestamp(email.receivedAt)), \(email.senderName.htmlEscapedForDraft) wrote:</p>
    \(quote)
    </blockquote>
    """
    let bodyText = "\n\nOn \(MailDateFormatter.listTimestamp(email.receivedAt)), \(email.senderName) wrote:\n> \(quotedText.replacingOccurrences(of: "\n", with: "\n> "))"

    return ComposeDraft(
      accountId: email.accountId,
      to: email.senderEmail,
      cc: "",
      bcc: "",
      subject: email.subject.replySubject,
      bodyHTML: bodyHTML,
      bodyText: bodyText,
      replyToEmailID: email.id
    )
  }
}

private extension String {
  var replySubject: String {
    let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.range(of: #"^re:"# , options: [.caseInsensitive, .regularExpression]) != nil {
      return trimmed
    }
    return "Re: \(trimmed.isEmpty ? "(No subject)" : trimmed)"
  }

  var htmlEscapedForDraft: String {
    replacingOccurrences(of: "&", with: "&amp;")
      .replacingOccurrences(of: "<", with: "&lt;")
      .replacingOccurrences(of: ">", with: "&gt;")
      .replacingOccurrences(of: "\"", with: "&quot;")
      .replacingOccurrences(of: "'", with: "&#39;")
  }
}

struct EmailQuery: Equatable {
  var accountId: String?
  var mailboxId: String?
  var mailboxRole: String?
  var labelId: String?
  var filterId: String?
  var q: String
  var unreadOnly: Bool = false
  var limit: Int = 80
  var offset: Int = 0
  var refreshFilterCache: Bool = false
}

enum ThemePreference: String, CaseIterable, Identifiable {
  case system
  case light
  case dark

  var id: String { rawValue }

  var title: String {
    switch self {
    case .system: "System"
    case .light: "Light"
    case .dark: "Dark"
    }
  }

  var colorScheme: ColorScheme? {
    switch self {
    case .system: nil
    case .light: .light
    case .dark: .dark
    }
  }
}

enum MailShortcutAction: String, Codable, CaseIterable, Identifiable {
  case compose
  case archive
  case refresh
  case search
  case toggleRead
  case toggleStar
  case markSpam

  var id: String { rawValue }

  var title: String {
    switch self {
    case .compose: "New Message"
    case .archive: "Archive Message"
    case .refresh: "Refresh Mail"
    case .search: "Search"
    case .toggleRead: "Mark Read/Unread"
    case .toggleStar: "Star/Unstar"
    case .markSpam: "Mark as Spam"
    }
  }

  var detail: String {
    switch self {
    case .compose: "Open the composer."
    case .archive: "Move the selected email to Archive."
    case .refresh: "Sync and reload accounts."
    case .search: "Focus the search field."
    case .toggleRead: "Toggle read state on the selected email."
    case .toggleStar: "Toggle star on the selected email."
    case .markSpam: "Move the selected email to Spam."
    }
  }

  var systemImage: String {
    switch self {
    case .compose: "square.and.pencil"
    case .archive: "archivebox"
    case .refresh: "arrow.clockwise"
    case .search: "magnifyingglass"
    case .toggleRead: "envelope.open"
    case .toggleStar: "star"
    case .markSpam: "exclamationmark.octagon"
    }
  }

  var defaultShortcut: MailKeyboardShortcut {
    switch self {
    case .compose:
      MailKeyboardShortcut(key: "n", modifierPreset: .command)
    case .archive:
      MailKeyboardShortcut(key: "delete", modifierPreset: .none)
    case .refresh:
      MailKeyboardShortcut(key: "r", modifierPreset: .command)
    case .search:
      MailKeyboardShortcut(key: "f", modifierPreset: .command)
    case .toggleRead:
      MailKeyboardShortcut(key: "u", modifierPreset: .commandShift)
    case .toggleStar:
      MailKeyboardShortcut(key: "s", modifierPreset: .none)
    case .markSpam:
      MailKeyboardShortcut(key: "j", modifierPreset: .commandShift)
    }
  }
}

struct MailShortcutBinding: Codable, Hashable, Identifiable {
  var action: MailShortcutAction
  var shortcut: MailKeyboardShortcut

  var id: String { action.id }

  static var defaults: [MailShortcutBinding] {
    MailShortcutAction.allCases.map { action in
      MailShortcutBinding(action: action, shortcut: action.defaultShortcut)
    }
  }
}

struct MailKeyboardShortcut: Codable, Hashable {
  var key: String
  var modifierPreset: MailShortcutModifierPreset

  var displayText: String {
    "\(modifierPreset.displayPrefix)\(Self.displayName(for: key))"
  }

  var isDeleteWithoutModifiers: Bool {
    key == "delete" && modifierPreset == .none
  }

  static let availableKeys: [String] = [
    "delete", "return", "space",
    "a", "b", "c", "d", "e", "f", "j", "k", "l", "m", "n", "r", "s", "u",
    "1", "2", "3", "4", "5", "6", "7", "8", "9"
  ]

  static func displayName(for key: String) -> String {
    switch key {
    case "delete": "Delete"
    case "return": "Return"
    case "space": "Space"
    default: key.uppercased()
    }
  }

  #if os(macOS)
  var keyEquivalent: KeyEquivalent? {
    switch key {
    case "delete":
      return KeyEquivalent.delete
    case "return":
      return KeyEquivalent.return
    case "space":
      return KeyEquivalent.space
    default:
      guard let character = key.lowercased().first else { return nil }
      return KeyEquivalent(character)
    }
  }

  var eventModifiers: EventModifiers {
    modifierPreset.eventModifiers
  }
  #endif
}

enum MailShortcutModifierPreset: String, Codable, CaseIterable, Identifiable {
  case none
  case command
  case commandShift
  case commandOption
  case control
  case option
  case shift

  var id: String { rawValue }

  var title: String {
    switch self {
    case .none: "None"
    case .command: "Command"
    case .commandShift: "Command + Shift"
    case .commandOption: "Command + Option"
    case .control: "Control"
    case .option: "Option"
    case .shift: "Shift"
    }
  }

  var displayPrefix: String {
    switch self {
    case .none: ""
    case .command: "Cmd+"
    case .commandShift: "Shift+Cmd+"
    case .commandOption: "Option+Cmd+"
    case .control: "Ctrl+"
    case .option: "Option+"
    case .shift: "Shift+"
    }
  }

  #if os(macOS)
  var eventModifiers: EventModifiers {
    switch self {
    case .none: []
    case .command: .command
    case .commandShift: [.command, .shift]
    case .commandOption: [.command, .option]
    case .control: .control
    case .option: .option
    case .shift: .shift
    }
  }
  #endif
}

extension View {
  @ViewBuilder
  func mailKeyboardShortcut(_ shortcut: MailKeyboardShortcut) -> some View {
    #if os(macOS)
    if let keyEquivalent = shortcut.keyEquivalent {
      keyboardShortcut(keyEquivalent, modifiers: shortcut.eventModifiers)
    } else {
      self
    }
    #else
    self
    #endif
  }
}
