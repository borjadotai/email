import Foundation

struct AccountsResponse: Decodable {
  var accounts: [MailAccount]
}

struct MailboxesResponse: Decodable {
  var mailboxes: [Mailbox]
}

struct LabelsResponse: Decodable {
  var labels: [MailLabel]
}

struct LabelResponse: Decodable {
  var label: MailLabel
}

struct FiltersResponse: Decodable {
  var filters: [MailFilter]
}

struct FilterResponse: Decodable {
  var filter: MailFilter
}

struct EmailsResponse: Decodable {
  var emails: [EmailSummary]
}

struct EmailResponse: Decodable {
  var email: EmailDetail
}

struct ThreadResponse: Decodable {
  var emails: [EmailDetail]
}

struct AccountResponse: Decodable {
  var account: MailAccount
}

struct ProfileResponse: Decodable {
  var profile: UserProfile
}

struct SendResponse: Decodable {
  var email: EmailDetail
  var trackingPixelURL: String?
}

struct RecipientSuggestionsResponse: Decodable {
  var contacts: [RecipientSuggestion]
}

struct BlockSenderResponse: Decodable {
  var rule: BlockedSenderRule
  var affectedCount: Int
  var email: EmailDetail
}

struct HealthResponse: Decodable {
  var status: String
  var databasePath: String
  var timestamp: String
}

struct AuthSettingsResponse: Decodable {
  var settings: AuthSettings
}

struct ErrorEnvelope: Decodable {
  var error: ServerError
}

struct ServerError: Decodable {
  var message: String
  var status: Int
}

enum MailAPIError: LocalizedError {
  case invalidURL
  case server(status: Int, message: String)
  case emptyResponse

  var errorDescription: String? {
    switch self {
    case .invalidURL:
      "The server URL is invalid."
    case .server(_, let message):
      message
    case .emptyResponse:
      "The server returned an empty response."
    }
  }
}

struct MailAPIClient: Sendable {
  var baseURL: URL
  var session: URLSession = .shared

  var normalizedBaseURL: URL {
    Self.normalizedServerBaseURL(baseURL)
  }

  static func normalizedServerBaseURL(_ url: URL) -> URL {
    guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
      return url
    }

    components.query = nil
    components.fragment = nil

    let path = components.percentEncodedPath
    if path == "/" || path == "/api" || path.hasPrefix("/api/") {
      components.percentEncodedPath = ""
    }

    return components.url ?? url
  }

  func health() async throws -> HealthResponse {
    try await request("api/health")
  }

  func accounts() async throws -> [MailAccount] {
    let response: AccountsResponse = try await request("api/accounts")
    return response.accounts
  }

  func reorderAccounts(ids: [String]) async throws -> [MailAccount] {
    let response: AccountsResponse = try await request(
      "api/accounts/order",
      method: "PATCH",
      body: ReorderRequest(ids: ids)
    )
    return response.accounts
  }

  func profile() async throws -> UserProfile {
    let response: ProfileResponse = try await request("api/profile")
    return response.profile
  }

  func addAccount(_ input: AddAccountRequest) async throws -> MailAccount {
    let response: AccountResponse = try await request("api/accounts", method: "POST", body: input)
    return response.account
  }

  func updateAccount(id: String, _ input: UpdateAccountSettingsRequest) async throws -> MailAccount {
    let response: AccountResponse = try await request("api/accounts/\(id)", method: "PATCH", body: input)
    return response.account
  }

  func authSettings() async throws -> AuthSettings {
    let response: AuthSettingsResponse = try await request("api/auth/settings")
    return response.settings
  }

  func startGmailAuth(_ input: GmailAuthStartRequest) async throws -> GmailAuthStartResponse {
    try await request("api/auth/gmail/start", method: "POST", body: input)
  }

  func connectICloud(_ input: ICloudConnectRequest) async throws -> ProviderConnectResponse {
    try await request("api/auth/icloud/connect", method: "POST", body: input)
  }

  func syncAccount(id: String, limit: Int? = nil, quick: Bool = false) async throws -> ProviderSyncResult {
    struct SyncRequest: Encodable {
      var limit: Int?
      var quick: Bool?
    }
    let query = quick ? [URLQueryItem(name: "quick", value: "1")] : []
    let response: SyncResponse = try await request(
      "api/accounts/\(id)/sync",
      method: "POST",
      query: query,
      body: SyncRequest(limit: limit, quick: quick ? true : nil)
    )
    return response.sync
  }

  func mailboxes() async throws -> [Mailbox] {
    let response: MailboxesResponse = try await request("api/mailboxes")
    return response.mailboxes
  }

  func labels() async throws -> [MailLabel] {
    let response: LabelsResponse = try await request("api/labels")
    return response.labels
  }

  func createLabel(name: String, color: String, icon: String, accountId: String? = nil) async throws -> MailLabel {
    struct LabelPayload: Encodable {
      var accountId: String?
      var name: String
      var color: String
      var icon: String
    }
    let response: LabelResponse = try await request(
      "api/labels",
      method: "POST",
      body: LabelPayload(accountId: accountId, name: name, color: color, icon: icon)
    )
    return response.label
  }

  func updateLabel(id: String, name: String, color: String, icon: String) async throws -> MailLabel {
    struct LabelPayload: Encodable {
      var name: String
      var color: String
      var icon: String
    }
    let response: LabelResponse = try await request(
      "api/labels/\(id)",
      method: "PATCH",
      body: LabelPayload(name: name, color: color, icon: icon)
    )
    return response.label
  }

  func filters() async throws -> [MailFilter] {
    let response: FiltersResponse = try await request("api/filters")
    return response.filters
  }

  func reorderFilters(ids: [String]) async throws -> [MailFilter] {
    let response: FiltersResponse = try await request(
      "api/filters/order",
      method: "PATCH",
      body: ReorderRequest(ids: ids)
    )
    return response.filters
  }

  func createFilter(naturalLanguage: String) async throws -> MailFilter {
    struct FilterPayload: Encodable {
      var naturalLanguage: String
      var criteria: MailFilterCriteria
    }
    let response: FilterResponse = try await request(
      "api/filters",
      method: "POST",
      body: FilterPayload(
        naturalLanguage: naturalLanguage,
        criteria: MailFilterCriteria()
      )
    )
    return response.filter
  }

  func updateFilter(
    id: String,
    naturalLanguage: String
  ) async throws -> MailFilter {
    struct FilterPayload: Encodable {
      var naturalLanguage: String
      var criteria: MailFilterCriteria
    }
    let response: FilterResponse = try await request(
      "api/filters/\(id)",
      method: "PATCH",
      body: FilterPayload(
        naturalLanguage: naturalLanguage,
        criteria: MailFilterCriteria()
      )
    )
    return response.filter
  }

  func deleteFilter(id: String) async throws -> MailFilter {
    let response: FilterResponse = try await request(
      "api/filters/\(id)",
      method: "DELETE",
      body: EmptyBody()
    )
    return response.filter
  }

  func emails(query: EmailQuery) async throws -> [EmailSummary] {
    var items: [URLQueryItem] = [URLQueryItem(name: "limit", value: String(query.limit))]
    if query.offset > 0 {
      items.append(URLQueryItem(name: "offset", value: String(query.offset)))
    }
    if let accountId = query.accountId {
      items.append(URLQueryItem(name: "accountId", value: accountId))
    }
    if let mailboxId = query.mailboxId {
      items.append(URLQueryItem(name: "mailboxId", value: mailboxId))
    }
    if let mailboxRole = query.mailboxRole {
      items.append(URLQueryItem(name: "mailboxRole", value: mailboxRole))
    }
    if let labelId = query.labelId {
      items.append(URLQueryItem(name: "labelId", value: labelId))
    }
    if let filterId = query.filterId {
      items.append(URLQueryItem(name: "filterId", value: filterId))
    }
    if query.refreshFilterCache {
      items.append(URLQueryItem(name: "refreshFilter", value: "1"))
    }
    if !query.q.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      items.append(URLQueryItem(name: "q", value: query.q))
    }

    let response: EmailsResponse = try await request("api/emails", query: items)
    return response.emails
  }

  func email(id: String) async throws -> EmailDetail {
    let response: EmailResponse = try await request("api/emails/\(id)")
    return response.email
  }

  func thread(emailId: String) async throws -> [EmailDetail] {
    let response: ThreadResponse = try await request("api/emails/\(emailId)/thread")
    return response.emails
  }

  func updateEmail(id: String, isRead: Bool? = nil, isStarred: Bool? = nil, mailboxId: String? = nil) async throws -> EmailDetail {
    struct Patch: Encodable {
      var isRead: Bool?
      var isStarred: Bool?
      var mailboxId: String?
    }
    let response: EmailResponse = try await request(
      "api/emails/\(id)",
      method: "PATCH",
      body: Patch(isRead: isRead, isStarred: isStarred, mailboxId: mailboxId)
    )
    return response.email
  }

  func setLabel(emailId: String, labelId: String, action: String) async throws -> EmailDetail {
    struct LabelPatch: Encodable {
      var labelId: String
      var action: String
    }
    let response: EmailResponse = try await request(
      "api/emails/\(emailId)/labels",
      method: "POST",
      body: LabelPatch(labelId: labelId, action: action)
    )
    return response.email
  }

  func markSpam(emailId: String) async throws -> EmailDetail {
    let response: EmailResponse = try await request(
      "api/emails/\(emailId)/spam",
      method: "POST",
      body: EmptyBody()
    )
    return response.email
  }

  func archiveEmail(emailId: String) async throws -> EmailDetail {
    let response: EmailResponse = try await request(
      "api/emails/\(emailId)/archive",
      method: "POST",
      body: EmptyBody()
    )
    return response.email
  }

  func trashEmail(emailId: String) async throws -> EmailDetail {
    let response: EmailResponse = try await request(
      "api/emails/\(emailId)/trash",
      method: "POST",
      body: EmptyBody()
    )
    return response.email
  }

  func blockSender(emailId: String, scope: BlockSenderScope) async throws -> BlockSenderResponse {
    struct BlockRequest: Encodable {
      var scope: BlockSenderScope
    }
    return try await request(
      "api/emails/\(emailId)/block",
      method: "POST",
      body: BlockRequest(scope: scope)
    )
  }

  func send(_ message: SendMessageRequest) async throws -> SendResponse {
    try await request("api/messages/send", method: "POST", body: message)
  }

  func recipientSuggestions(query: String, limit: Int = 8) async throws -> [RecipientSuggestion] {
    let response: RecipientSuggestionsResponse = try await request(
      "api/contacts/suggest",
      query: [
        URLQueryItem(name: "q", value: query),
        URLQueryItem(name: "limit", value: String(limit))
      ]
    )
    return response.contacts
  }

  func registerPushToken(_ input: PushTokenRegistrationRequest) async throws -> PushTokenRegistrationResponse {
    try await request("api/push/tokens", method: "POST", body: input)
  }

  func downloadAttachment(emailId: String, attachmentId: String) async throws -> Data {
    let url = try attachmentDownloadURL(emailId: emailId, attachmentId: attachmentId)
    var request = URLRequest(url: url)
    request.timeoutInterval = 120

    let (data, response) = try await session.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard (200..<300).contains(status) else {
      let message = (try? JSONDecoder().decode(ErrorEnvelope.self, from: data).error.message) ??
        String(data: data, encoding: .utf8) ??
        "Attachment download failed."
      throw MailAPIError.server(status: status, message: message)
    }
    return data
  }

  func attachmentDownloadURL(emailId: String, attachmentId: String) throws -> URL {
    guard let url = URL(
      string: "api/emails/\(emailId)/attachments/\(attachmentId)/download",
      relativeTo: normalizedBaseURL
    )?.absoluteURL else {
      throw MailAPIError.invalidURL
    }
    return url
  }

  private func request<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
    try await request(path, method: "GET", query: query, bodyData: nil)
  }

  private func request<T: Decodable, Body: Encodable>(
    _ path: String,
    method: String,
    query: [URLQueryItem] = [],
    body: Body
  ) async throws -> T {
    let encoder = JSONEncoder()
    encoder.keyEncodingStrategy = .useDefaultKeys
    return try await request(path, method: method, query: query, bodyData: encoder.encode(body))
  }

  private func request<T: Decodable>(
    _ path: String,
    method: String,
    query: [URLQueryItem],
    bodyData: Data?
  ) async throws -> T {
    guard var components = URLComponents(
      url: normalizedBaseURL.appendingPathComponent(path),
      resolvingAgainstBaseURL: false
    ) else {
      throw MailAPIError.invalidURL
    }
    components.queryItems = query.isEmpty ? nil : query
    guard let url = components.url else {
      throw MailAPIError.invalidURL
    }

    var request = URLRequest(url: url)
    request.httpMethod = method
    request.timeoutInterval = timeout(for: path, query: query)
    if let bodyData {
      request.httpBody = bodyData
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }

    let (data, response) = try await session.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard (200..<300).contains(status) else {
      let message = (try? JSONDecoder().decode(ErrorEnvelope.self, from: data).error.message) ??
        String(data: data, encoding: .utf8) ??
        "Request failed."
      throw MailAPIError.server(status: status, message: message)
    }
    guard !data.isEmpty else {
      throw MailAPIError.emptyResponse
    }

    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .useDefaultKeys
    return try decoder.decode(T.self, from: data)
  }

  private func timeout(for path: String, query: [URLQueryItem]) -> TimeInterval {
    if path == "api/auth/icloud/connect" || path.hasSuffix("/sync") {
      if query.contains(where: { $0.name == "quick" && $0.value == "1" }) {
        return 5
      }
      return 180
    }
    return 30
  }
}

private struct EmptyBody: Encodable {}

private struct ReorderRequest: Encodable {
  var ids: [String]
}
