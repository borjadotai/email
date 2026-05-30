import Foundation
import Intents
import UIKit
import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
  private static let defaultAppName = "Email"

  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var bestAttemptContent: UNMutableNotificationContent?

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    self.contentHandler = contentHandler

    guard let bestAttemptContent = request.content.mutableCopy() as? UNMutableNotificationContent else {
      contentHandler(request.content)
      return
    }

    self.bestAttemptContent = bestAttemptContent
    Task { [bestAttemptContent, contentHandler] in
      let content = await Self.enrichedContent(from: bestAttemptContent)
      contentHandler(content)
    }
  }

  override func serviceExtensionTimeWillExpire() {
    guard let contentHandler, let bestAttemptContent else { return }
    contentHandler(bestAttemptContent)
  }

  private static func enrichedContent(from content: UNMutableNotificationContent) async -> UNNotificationContent {
    let userInfo = content.userInfo
    let senderName = stringValue(for: "senderName", in: userInfo) ?? content.title
    let senderEmail = stringValue(for: "senderEmail", in: userInfo)
    let appName = stringValue(for: "appName", in: userInfo) ?? defaultAppName
    let subject = stringValue(for: "subject", in: userInfo) ?? content.subtitle
    let displaySubject = subject.isEmpty ? "(No subject)" : subject

    content.title = appName
    content.subtitle = senderName
    content.body = displaySubject

    let avatarData = await avatarData(
      from: stringValue(for: "senderAvatarURL", in: userInfo),
      senderName: senderName,
      senderEmail: senderEmail
    )
    if let communicationContent = communicationNotificationContent(
      from: content,
      appName: appName,
      senderName: senderName,
      senderEmail: senderEmail,
      subject: displaySubject,
      avatarData: avatarData,
      userInfo: userInfo
    ) {
      return communicationContent
    }

    if let attachment = avatarData.flatMap({ avatarAttachment(from: $0) }) {
      content.attachments = [attachment]
    }
    return content
  }

  private static func communicationNotificationContent(
    from content: UNMutableNotificationContent,
    appName: String,
    senderName: String,
    senderEmail: String?,
    subject: String,
    avatarData: Data?,
    userInfo: [AnyHashable: Any]
  ) -> UNNotificationContent? {
    let threadIdentifier = content.threadIdentifier
    let handle = INPersonHandle(
      value: senderEmail ?? senderName,
      type: senderEmail == nil ? .unknown : .emailAddress
    )
    let senderImage = avatarData.map(INImage.init(imageData:))
    let sender = INPerson(
      personHandle: handle,
      nameComponents: nil,
      displayName: senderName,
      image: senderImage,
      contactIdentifier: nil,
      customIdentifier: senderEmail
    )
    let conversationIdentifier = stringValue(for: "threadId", in: userInfo)
      ?? stringValue(for: "emailId", in: userInfo)
      ?? UUID().uuidString
    let intent = INSendMessageIntent(
      recipients: nil,
      outgoingMessageType: .outgoingMessageText,
      content: subject,
      speakableGroupName: nil,
      conversationIdentifier: conversationIdentifier,
      serviceName: appName,
      sender: sender,
      attachments: nil
    )
    if let senderImage {
      intent.setImage(senderImage, forParameterNamed: \.sender)
    }
    let interaction = INInteraction(intent: intent, response: nil)
    interaction.direction = .incoming
    interaction.donate(completion: nil)

    do {
      guard let updatedContent = try content.updating(from: intent).mutableCopy() as? UNMutableNotificationContent else {
        return nil
      }
      updatedContent.title = appName
      updatedContent.subtitle = senderName
      updatedContent.body = subject
      updatedContent.threadIdentifier = threadIdentifier
      return updatedContent
    } catch {
      return nil
    }
  }

  private static func avatarData(from urlString: String?, senderName: String, senderEmail: String?) async -> Data? {
    if let embeddedData = embeddedAvatarData(from: urlString) {
      return embeddedData
    }

    if let remoteData = await remoteAvatarData(from: urlString) {
      return remoteData
    }

    return generatedAvatarData(senderName: senderName, senderEmail: senderEmail)
  }

  private static func embeddedAvatarData(from urlString: String?) -> Data? {
    guard let rawValue = urlString?.trimmingCharacters(in: .whitespacesAndNewlines),
          rawValue.lowercased().hasPrefix("data:image/"),
          let commaIndex = rawValue.firstIndex(of: ",")
    else {
      return nil
    }

    let metadata = rawValue[..<commaIndex].lowercased()
    let payload = String(rawValue[rawValue.index(after: commaIndex)...])
    if metadata.contains(";base64") {
      return Data(base64Encoded: payload)
    }
    return payload.removingPercentEncoding?.data(using: .utf8)
  }

  private static func remoteAvatarData(from urlString: String?) async -> Data? {
    guard let rawURL = urlString?.trimmingCharacters(in: .whitespacesAndNewlines),
          let url = URL(string: rawURL),
          ["http", "https"].contains(url.scheme?.lowercased())
    else {
      return nil
    }

    do {
      let (data, response) = try await URLSession.shared.data(from: url)
      if let response = response as? HTTPURLResponse, !(200..<300).contains(response.statusCode) {
        return nil
      }
      return data.isEmpty ? nil : data
    } catch {
      return nil
    }
  }

  private static func generatedAvatarData(senderName: String, senderEmail: String?) -> Data? {
    let initials = initials(for: senderName, email: senderEmail)
    let renderer = UIGraphicsImageRenderer(size: CGSize(width: 128, height: 128))
    let image = renderer.image { context in
      let bounds = CGRect(x: 0, y: 0, width: 128, height: 128)
      UIBezierPath(roundedRect: bounds, cornerRadius: 30).addClip()

      UIColor.systemGray5.setFill()
      context.cgContext.fill(bounds)

      let paragraphStyle = NSMutableParagraphStyle()
      paragraphStyle.alignment = .center
      let attributes: [NSAttributedString.Key: Any] = [
        .font: UIFont.systemFont(ofSize: 44, weight: .semibold),
        .foregroundColor: UIColor.secondaryLabel,
        .paragraphStyle: paragraphStyle
      ]
      let textRect = CGRect(x: 0, y: 36, width: 128, height: 58)
      initials.draw(with: textRect, options: [.usesLineFragmentOrigin], attributes: attributes, context: nil)
    }
    return image.pngData()
  }

  private static func initials(for senderName: String, email: String?) -> String {
    let source = stringValue(senderName) ?? stringValue(email) ?? "E"
    let parts = source.split(separator: " ")
    let letters = parts.prefix(2).compactMap(\.first)
    if letters.isEmpty, let first = source.first {
      return String(first).uppercased()
    }
    return String(letters).uppercased()
  }

  private static func avatarAttachment(from data: Data) -> UNNotificationAttachment? {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    let fileURL = directory.appendingPathComponent("sender-avatar.png")

    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      try data.write(to: fileURL, options: .atomic)
      return try UNNotificationAttachment(identifier: "senderAvatar", url: fileURL)
    } catch {
      return nil
    }
  }

  private static func stringValue(for key: String, in userInfo: [AnyHashable: Any]) -> String? {
    guard let value = userInfo[key] as? String else { return nil }
    return stringValue(value)
  }

  private static func stringValue(_ value: String?) -> String? {
    guard let value else { return nil }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }
}
