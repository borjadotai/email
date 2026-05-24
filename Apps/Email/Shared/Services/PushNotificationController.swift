import Foundation
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

  private weak var model: AppModel?
  private var pendingEmailID: String?
  private var hasStarted = false

  func installNotificationDelegate() {
    UNUserNotificationCenter.current().delegate = self
  }

  func start(model: AppModel) async {
    self.model = model
    installNotificationDelegate()

    if let pendingEmailID {
      self.pendingEmailID = nil
      await openEmail(id: pendingEmailID)
    }

    guard !hasStarted else { return }
    hasStarted = true

    do {
      _ = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
    } catch {
      model.statusMessage = nil
      model.errorMessage = "Notification permission failed: \(error.localizedDescription)"
    }
  }

  func notifyNewEmails(_ emails: [EmailDetail]) async {
    guard !emails.isEmpty else { return }
    let center = UNUserNotificationCenter.current()
    let settings = await center.notificationSettings()
    guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else { return }

    for email in emails {
      let content = UNMutableNotificationContent()
      content.title = email.senderName.isEmpty ? email.senderEmail : email.senderName
      content.body = email.subject.isEmpty ? "(No subject)" : email.subject
      content.sound = .default
      content.userInfo = [
        "emailId": email.id,
        "threadId": email.threadId ?? "",
        "accountId": email.accountId
      ]

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
    let userInfo = response.notification.request.content.userInfo
    let emailID = Self.emailID(from: userInfo)
    Task { @MainActor [weak self] in
      if let emailID {
        await self?.openEmail(id: emailID)
      }
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

  nonisolated private static func emailID(from userInfo: [AnyHashable: Any]) -> String? {
    userInfo["emailId"] as? String
      ?? userInfo["email_id"] as? String
      ?? userInfo["emailID"] as? String
  }
}

#if os(iOS)
@MainActor
final class BackgroundMailRefreshController {
  static let shared = BackgroundMailRefreshController()
  static let taskIdentifier = "com.borjadotai.email.mail-refresh"

  private let interval: TimeInterval = 5 * 60

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
    Task { @MainActor in
      PushNotificationController.shared.installNotificationDelegate()
    }
    return true
  }

}
#elseif os(macOS)
final class EmailMacAppDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) {
    Task { @MainActor in
      PushNotificationController.shared.installNotificationDelegate()
    }
  }

}
#endif
