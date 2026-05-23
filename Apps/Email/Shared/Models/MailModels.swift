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
  var isSystem: Bool
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

struct EmailDetail: Codable, Identifiable, Hashable {
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
  var recipients: [String]
  var cc: [String]
  var bcc: [String]
  var subject: String
  var snippet: String
  var bodyText: String
  var bodyHTML: String?
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
  var displayName: String
  var appPassword: String
  var syncHistory: Bool
}

struct ProviderSyncResult: Codable, Hashable {
  var provider: String
  var imported: Int
}

struct ProviderConnectResponse: Decodable {
  var account: MailAccount
  var sync: ProviderSyncResult
}

struct SyncResponse: Decodable {
  var sync: ProviderSyncResult
}

struct SendMessageRequest: Encodable {
  var accountId: String
  var to: String
  var cc: String
  var bcc: String
  var subject: String
  var bodyText: String
  var trackOpens: Bool
}

struct EmailQuery: Equatable {
  var accountId: String?
  var mailboxId: String?
  var labelId: String?
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
