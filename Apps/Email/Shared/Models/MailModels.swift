import Foundation
import SwiftUI

enum MailProvider: String, Codable, CaseIterable, Identifiable {
  case gmail
  case icloud

  var id: String { rawValue }

  var displayName: String {
    switch self {
    case .gmail: "Gmail"
    case .icloud: "iCloud"
    }
  }

  var systemImage: String {
    switch self {
    case .gmail: "envelope.circle"
    case .icloud: "icloud"
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
  var lastSyncAt: String?
  var createdAt: String
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
  var createdAt: String
  var updatedAt: String
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

struct ProviderConnectResponse: Decodable {
  var account: MailAccount
  var sync: ProviderSyncResult
}

struct SyncResponse: Decodable {
  var sync: ProviderSyncResult
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
  var limit: Int = 80
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
