import Foundation
import UniformTypeIdentifiers
import UserNotifications

#if os(iOS)
import BackgroundTasks
import UIKit
#elseif os(macOS)
import AppKit
#endif

@MainActor
final class PushNotificationController: NSObject, UNUserNotificationCenterDelegate {
  static let shared = PushNotificationController()
  private static let inboxNotificationThreadIdentifier = "email.inbox"

  private weak var model: AppModel?
  private var pendingEmailID: String?
  private var latestRemoteDeviceToken: Data?
  private var hasStarted = false

  func installNotificationDelegate() {
    UNUserNotificationCenter.current().delegate = self
  }

  func start(model: AppModel) async {
    self.model = model
    installNotificationDelegate()
    refreshApplicationBadge()

    if let pendingEmailID {
      self.pendingEmailID = nil
      await openEmail(id: pendingEmailID)
    }
    await registerCurrentDeviceTokenIfAvailable()

    guard !hasStarted else { return }
    hasStarted = true

    do {
      _ = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
    } catch {
      print("Notification permission unavailable: \(error.localizedDescription)")
    }

    registerForRemoteNotifications()
  }

  func setApplicationBadgeCount(_ count: Int) {
    let badgeCount = max(0, count)
    #if os(iOS)
    UNUserNotificationCenter.current().setBadgeCount(badgeCount) { error in
      if let error {
        print("Badge update failed: \(error.localizedDescription)")
      }
    }
    #elseif os(macOS)
    NSApplication.shared.dockTile.badgeLabel = badgeCount > 0 ? "\(badgeCount)" : nil
    NSApplication.shared.dockTile.display()
    #endif
  }

  func refreshApplicationBadge() {
    setApplicationBadgeCount(model?.globalUnreadCount ?? 0)
  }

  func didRegisterForRemoteNotifications(deviceToken: Data) async {
    latestRemoteDeviceToken = deviceToken
    await registerRemoteDeviceToken(deviceToken)
  }

  func didFailToRegisterForRemoteNotifications(error: Error) {
    print("Remote notification registration failed: \(error.localizedDescription)")
  }

  func registerCurrentDeviceTokenIfAvailable() async {
    guard let latestRemoteDeviceToken else { return }
    await registerRemoteDeviceToken(latestRemoteDeviceToken)
  }

  func openNotification(emailID: String) async {
    await openEmail(id: emailID)
  }

  func notifyNewEmails(_ emails: [EmailDetail]) async {
    guard !emails.isEmpty else { return }
    let badgeCount = model?.globalUnreadCount ?? emails.count
    setApplicationBadgeCount(badgeCount)

    let center = UNUserNotificationCenter.current()
    let settings = await center.notificationSettings()
    guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else { return }

    for email in emails {
      let senderName = email.senderName.isEmpty ? email.senderEmail : email.senderName
      let content = UNMutableNotificationContent()
      content.title = "Email"
      content.subtitle = senderName
      content.body = Self.notificationSubject(for: email)
      content.sound = .default
      content.badge = NSNumber(value: max(1, badgeCount))
      content.threadIdentifier = Self.inboxNotificationThreadIdentifier
      content.userInfo = [
        "emailId": email.id,
        "threadId": email.threadId ?? "",
        "accountId": email.accountId,
        "senderName": senderName,
        "senderEmail": email.senderEmail,
        "senderAvatarURL": email.senderAvatarURL ?? "",
        "appName": content.title,
        "subject": content.body,
        "snippet": Self.notificationPreview(for: email)
      ]
      if let attachment = await Self.avatarAttachment(urlString: email.senderAvatarURL, identifier: email.id) {
        content.attachments = [attachment]
      }

      let request = UNNotificationRequest(
        identifier: "email.\(email.id)",
        content: content,
        trigger: nil
      )
      try? await center.add(request)
    }
  }

  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .list, .sound, .badge])
  }

  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let emailID = Self.emailID(from: response.notification.request.content.userInfo)
    Task { @MainActor [weak self, emailID] in
      guard let emailID else { return }
      await self?.openNotification(emailID: emailID)
    }
    completionHandler()
  }

  private func openEmail(id: String) async {
    guard let model else {
      pendingEmailID = id
      return
    }
    await model.openEmailFromNotification(id: id)
  }

  private func registerForRemoteNotifications() {
    #if os(iOS)
    UIApplication.shared.registerForRemoteNotifications()
    #elseif os(macOS)
    NSApplication.shared.registerForRemoteNotifications(matching: [.alert, .badge, .sound])
    #endif
  }

  private func registerRemoteDeviceToken(_ deviceToken: Data) async {
    guard let model else { return }
    guard let bundleId = Bundle.main.bundleIdentifier else { return }

    let request = PushTokenRegistrationRequest(
      token: Self.hexString(for: deviceToken),
      platform: Self.platform,
      bundleId: bundleId,
      environment: Self.currentAPNsEnvironment(),
      deviceName: Self.deviceName
    )

    do {
      let response = try await model.apiClient.registerPushToken(request)
      if !response.pushConfigured {
        print("Remote notification token registered, but the server is missing APNs credentials.")
      }
    } catch {
      print("Remote notification token upload failed: \(error.localizedDescription)")
    }
  }

  nonisolated static func emailID(from userInfo: [AnyHashable: Any]) -> String? {
    userInfo["emailId"] as? String
      ?? userInfo["email_id"] as? String
      ?? userInfo["emailID"] as? String
  }

  nonisolated private static var platform: String {
    #if os(iOS)
    "ios"
    #elseif os(macOS)
    "macos"
    #else
    "unknown"
    #endif
  }

  private static var deviceName: String? {
    #if os(iOS)
    UIDevice.current.name
    #elseif os(macOS)
    Host.current().localizedName
    #else
    nil
    #endif
  }

  private static func currentAPNsEnvironment() -> String {
    if let environment = Bundle.main.object(forInfoDictionaryKey: "EmailAPNSEnvironment") as? String,
       environment == "development" || environment == "production" {
      return environment
    }

    #if DEBUG
    return "development"
    #else
    return "production"
    #endif
  }

  nonisolated private static func hexString(for data: Data) -> String {
    data.map { String(format: "%02x", $0) }.joined()
  }

  nonisolated private static func notificationSubject(for email: EmailDetail) -> String {
    let subject = email.subject.trimmingCharacters(in: .whitespacesAndNewlines)
    return subject.isEmpty ? "(No subject)" : subject
  }

  nonisolated private static func notificationPreview(for email: EmailDetail) -> String {
    firstPreviewLine(email.snippet) ?? firstPreviewLine(email.bodyText) ?? "Open Email to read this message."
  }

  nonisolated private static func firstPreviewLine(_ value: String) -> String? {
    for rawLine in value.components(separatedBy: .newlines) {
      let line = rawLine
        .components(separatedBy: .whitespaces)
        .filter { !$0.isEmpty }
        .joined(separator: " ")
        .trimmingCharacters(in: .whitespacesAndNewlines)
      if !line.isEmpty {
        return String(line.prefix(180))
      }
    }
    return nil
  }

  private static func avatarAttachment(urlString: String?, identifier: String) async -> UNNotificationAttachment? {
    guard let rawURL = urlString?.trimmingCharacters(in: .whitespacesAndNewlines),
          let url = URL(string: rawURL),
          ["http", "https"].contains(url.scheme?.lowercased())
    else {
      return nil
    }

    do {
      let (downloadedURL, response) = try await URLSession.shared.download(from: url)
      if let response = response as? HTTPURLResponse, !(200..<300).contains(response.statusCode) {
        return nil
      }

      let destination = FileManager.default.temporaryDirectory
        .appendingPathComponent("email-notification-\(identifier)")
        .appendingPathExtension(fileExtension(for: response))
      try? FileManager.default.removeItem(at: destination)
      try FileManager.default.copyItem(at: downloadedURL, to: destination)
      return try UNNotificationAttachment(identifier: "senderAvatar", url: destination)
    } catch {
      return nil
    }
  }

  private static func fileExtension(for response: URLResponse) -> String {
    guard let mimeType = response.mimeType,
          let type = UTType(mimeType: mimeType),
          let preferredExtension = type.preferredFilenameExtension
    else {
      return "png"
    }
    return preferredExtension
  }
}

#if os(iOS)
@MainActor
final class BackgroundMailRefreshController {
  static let shared = BackgroundMailRefreshController()
  static let taskIdentifier = "com.borjadotai.email.mail-refresh"

  private let interval: TimeInterval = 60

  func scheduleNextRefresh() {
    let request = BGAppRefreshTaskRequest(identifier: Self.taskIdentifier)
    request.earliestBeginDate = Date(timeIntervalSinceNow: interval)
    try? BGTaskScheduler.shared.submit(request)
  }

  func handleAppRefresh(model: AppModel) async {
    scheduleNextRefresh()
    let ids = await model.pollAllMailForNewEmails()
    let emails = await model.emailDetails(for: ids)
    await PushNotificationController.shared.notifyNewEmails(emails)
  }
}
#endif

#if os(iOS)
final class EmailAppDelegate: NSObject, UIApplicationDelegate {
  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let notificationEmailID = (launchOptions?[.remoteNotification] as? [AnyHashable: Any]).flatMap {
      PushNotificationController.emailID(from: $0)
    }
    Task { @MainActor in
      PushNotificationController.shared.installNotificationDelegate()
      if let notificationEmailID {
        await PushNotificationController.shared.openNotification(emailID: notificationEmailID)
      }
    }
    return true
  }

  func application(
    _ application: UIApplication,
    didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    Task { @MainActor in
      await PushNotificationController.shared.didRegisterForRemoteNotifications(deviceToken: deviceToken)
    }
  }

  func application(
    _ application: UIApplication,
    didFailToRegisterForRemoteNotificationsWithError error: Error
  ) {
    Task { @MainActor in
      PushNotificationController.shared.didFailToRegisterForRemoteNotifications(error: error)
    }
  }
}
#elseif os(macOS)
final class EmailMacAppDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) {
    Task { @MainActor in
      PushNotificationController.shared.installNotificationDelegate()
    }
  }

  func application(
    _ application: NSApplication,
    didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    Task { @MainActor in
      await PushNotificationController.shared.didRegisterForRemoteNotifications(deviceToken: deviceToken)
    }
  }

  func application(
    _ application: NSApplication,
    didFailToRegisterForRemoteNotificationsWithError error: Error
  ) {
    Task { @MainActor in
      PushNotificationController.shared.didFailToRegisterForRemoteNotifications(error: error)
    }
  }
}
#endif
