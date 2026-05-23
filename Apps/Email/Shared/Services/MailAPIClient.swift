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

struct EmailsResponse: Decodable {
  var emails: [EmailSummary]
}

struct EmailResponse: Decodable {
  var email: EmailDetail
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

struct MailAPIClient {
  var baseURL: URL
  var session: URLSession = .shared

  func health() async throws -> HealthResponse {
    try await request("api/health")
  }

  func accounts() async throws -> [MailAccount] {
    let response: AccountsResponse = try await request("api/accounts")
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

  func syncAccount(id: String) async throws -> ProviderSyncResult {
    let response: SyncResponse = try await request("api/accounts/\(id)/sync", method: "POST", body: EmptyBody())
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

  func emails(query: EmailQuery) async throws -> [EmailSummary] {
    var items: [URLQueryItem] = [URLQueryItem(name: "limit", value: String(query.limit))]
    if let accountId = query.accountId {
      items.append(URLQueryItem(name: "accountId", value: accountId))
    }
    if let mailboxId = query.mailboxId {
      items.append(URLQueryItem(name: "mailboxId", value: mailboxId))
    }
    if let labelId = query.labelId {
      items.append(URLQueryItem(name: "labelId", value: labelId))
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

  func send(_ message: SendMessageRequest) async throws -> SendResponse {
    try await request("api/messages/send", method: "POST", body: message)
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
      url: baseURL.appendingPathComponent(path),
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
    request.timeoutInterval = timeout(for: path)
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

  private func timeout(for path: String) -> TimeInterval {
    if path == "api/auth/icloud/connect" || path.hasSuffix("/sync") {
      return 180
    }
    return 30
  }
}

private struct EmptyBody: Encodable {}
