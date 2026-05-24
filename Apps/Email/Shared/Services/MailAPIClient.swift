import Foundation
import Security

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

struct MailAPIClient {
  var baseURL: URL
  var session: URLSession = .shared
  var accessToken: String?

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

  func syncAccount(id: String, limit: Int? = nil) async throws -> ProviderSyncResult {
    struct SyncRequest: Encodable {
      var limit: Int?
    }
    let response: SyncResponse = try await request("api/accounts/\(id)/sync", method: "POST", body: SyncRequest(limit: limit))
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
    if let mailboxRole = query.mailboxRole {
      items.append(URLQueryItem(name: "mailboxRole", value: mailboxRole))
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

  func registerPushToken(_ input: PushTokenRegistrationRequest) async throws -> PushTokenRegistrationResponse {
    try await request("api/push/tokens", method: "POST", body: input)
  }

  func downloadAttachment(emailId: String, attachmentId: String) async throws -> Data {
    let url = try attachmentDownloadURL(emailId: emailId, attachmentId: attachmentId)
    var request = URLRequest(url: url)
    request.timeoutInterval = 120
    applyAuthorization(to: &request)

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
    guard let url = URL(string: "api/emails/\(emailId)/attachments/\(attachmentId)/download", relativeTo: baseURL)?.absoluteURL else {
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
    applyAuthorization(to: &request)
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

  private func applyAuthorization(to request: inout URLRequest) {
    guard let accessToken, !accessToken.isEmpty else { return }
    request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
  }
}

private struct EmptyBody: Encodable {}

struct AuthSession: Codable, Hashable {
  var accessToken: String
  var refreshToken: String
  var expiresAt: Date
  var user: AuthUser?

  var shouldRefresh: Bool {
    expiresAt.timeIntervalSinceNow < 120
  }
}

struct AuthUser: Codable, Hashable {
  var id: String
  var email: String?
}

enum SupabaseAuthError: LocalizedError {
  case missingConfiguration
  case missingSession
  case server(String)

  var errorDescription: String? {
    switch self {
    case .missingConfiguration:
      "Supabase Auth is not configured for this server."
    case .missingSession:
      "Sign in is required."
    case .server(let message):
      message
    }
  }
}

struct SupabaseAuthClient {
  var url: URL
  var publishableKey: String
  var session: URLSession = .shared

  func signIn(email: String, password: String) async throws -> AuthSession {
    let response: SupabaseTokenResponse = try await request(
      "auth/v1/token",
      query: [URLQueryItem(name: "grant_type", value: "password")],
      method: "POST",
      body: EmailPasswordRequest(email: email, password: password)
    )
    guard let authSession = response.authSession else {
      throw SupabaseAuthError.server("Supabase did not return a session.")
    }
    return authSession
  }

  func signUp(email: String, password: String) async throws -> AuthSession? {
    let response: SupabaseSignUpResponse = try await request(
      "auth/v1/signup",
      method: "POST",
      body: EmailPasswordRequest(email: email, password: password)
    )
    return response.authSession
  }

  func refresh(_ refreshToken: String) async throws -> AuthSession {
    let response: SupabaseTokenResponse = try await request(
      "auth/v1/token",
      query: [URLQueryItem(name: "grant_type", value: "refresh_token")],
      method: "POST",
      body: RefreshTokenRequest(refreshToken: refreshToken)
    )
    guard let authSession = response.authSession else {
      throw SupabaseAuthError.server("Supabase did not return a refreshed session.")
    }
    return authSession
  }

  private func request<Response: Decodable, Body: Encodable>(
    _ path: String,
    query: [URLQueryItem] = [],
    method: String,
    body: Body
  ) async throws -> Response {
    guard !publishableKey.isEmpty else {
      throw SupabaseAuthError.missingConfiguration
    }
    guard var components = URLComponents(
      url: url.appendingPathComponent(path),
      resolvingAgainstBaseURL: false
    ) else {
      throw MailAPIError.invalidURL
    }
    components.queryItems = query.isEmpty ? nil : query
    guard let requestURL = components.url else {
      throw MailAPIError.invalidURL
    }

    var request = URLRequest(url: requestURL)
    request.httpMethod = method
    request.timeoutInterval = 30
    request.setValue(publishableKey, forHTTPHeaderField: "apikey")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONEncoder.supabase.encode(body)

    let (data, response) = try await session.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard (200..<300).contains(status) else {
      let message = (try? JSONDecoder.supabase.decode(SupabaseErrorResponse.self, from: data).message) ??
        String(data: data, encoding: .utf8) ??
        "Authentication failed."
      throw SupabaseAuthError.server(message)
    }
    return try JSONDecoder.supabase.decode(Response.self, from: data)
  }
}

@MainActor
final class AuthSessionStore {
  static let shared = AuthSessionStore()

  private let service = "EmailApp.AuthSession"
  private let account = "supabase"

  func load() -> AuthSession? {
    var query = baseQuery()
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne

    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    guard status == errSecSuccess, let data = item as? Data else {
      return nil
    }
    return try? JSONDecoder().decode(AuthSession.self, from: data)
  }

  func save(_ session: AuthSession) {
    guard let data = try? JSONEncoder().encode(session) else { return }
    var query = baseQuery()
    let attributes: [String: Any] = [kSecValueData as String: data]
    let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if status == errSecItemNotFound {
      query[kSecValueData as String] = data
      query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      SecItemAdd(query as CFDictionary, nil)
    }
  }

  func clear() {
    SecItemDelete(baseQuery() as CFDictionary)
  }

  private func baseQuery() -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account
    ]
  }
}

private struct EmailPasswordRequest: Encodable {
  var email: String
  var password: String
}

private struct RefreshTokenRequest: Encodable {
  var refreshToken: String
}

private struct SupabaseTokenResponse: Decodable {
  var accessToken: String?
  var refreshToken: String?
  var expiresIn: Int?
  var expiresAt: Int?
  var user: AuthUser?

  var authSession: AuthSession? {
    guard let accessToken, let refreshToken else { return nil }
    return AuthSession(
      accessToken: accessToken,
      refreshToken: refreshToken,
      expiresAt: sessionExpiry(expiresIn: expiresIn, expiresAt: expiresAt),
      user: user
    )
  }
}

private struct SupabaseSignUpResponse: Decodable {
  var session: SupabaseTokenResponse?
  var accessToken: String?
  var refreshToken: String?
  var expiresIn: Int?
  var expiresAt: Int?
  var user: AuthUser?

  var authSession: AuthSession? {
    session?.authSession ??
      SupabaseTokenResponse(
        accessToken: accessToken,
        refreshToken: refreshToken,
        expiresIn: expiresIn,
        expiresAt: expiresAt,
        user: user
      ).authSession
  }
}

private struct SupabaseErrorResponse: Decodable {
  var message: String?
  var errorDescription: String?

  enum CodingKeys: String, CodingKey {
    case message
    case msg
    case error
    case errorDescription = "error_description"
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    message = try container.decodeIfPresent(String.self, forKey: .message) ??
      container.decodeIfPresent(String.self, forKey: .msg) ??
      container.decodeIfPresent(String.self, forKey: .errorDescription) ??
      container.decodeIfPresent(String.self, forKey: .error)
  }
}

private func sessionExpiry(expiresIn: Int?, expiresAt: Int?) -> Date {
  if let expiresAt {
    return Date(timeIntervalSince1970: TimeInterval(expiresAt))
  }
  return Date().addingTimeInterval(TimeInterval(expiresIn ?? 3600))
}

private extension JSONDecoder {
  static var supabase: JSONDecoder {
    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase
    return decoder
  }
}

private extension JSONEncoder {
  static var supabase: JSONEncoder {
    let encoder = JSONEncoder()
    encoder.keyEncodingStrategy = .convertToSnakeCase
    return encoder
  }
}
