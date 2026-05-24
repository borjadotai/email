import Foundation
import SwiftUI

@MainActor
enum MailDateFormatter {
  private static let isoWithFractional: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }()

  private static let iso: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    return formatter
  }()

  private static let shortDate: DateFormatter = {
    let formatter = DateFormatter()
    formatter.dateStyle = .medium
    formatter.timeStyle = .none
    return formatter
  }()

  private static let shortTime: DateFormatter = {
    let formatter = DateFormatter()
    formatter.dateStyle = .none
    formatter.timeStyle = .short
    return formatter
  }()

  private static let dayMonthDate: DateFormatter = {
    let formatter = DateFormatter()
    formatter.setLocalizedDateFormatFromTemplate("dMMM")
    return formatter
  }()

  static func date(from value: String) -> Date? {
    isoWithFractional.date(from: value) ?? iso.date(from: value)
  }

  static func listTimestamp(_ value: String) -> String {
    guard let date = date(from: value) else { return value }
    if Calendar.current.isDateInToday(date) {
      return shortTime.string(from: date)
    }
    return shortDate.string(from: date)
  }

  static func inboxTimestamp(_ value: String) -> String {
    guard let date = date(from: value) else { return value }
    if Calendar.current.isDateInToday(date) {
      return shortTime.string(from: date)
    }
    return dayMonthDate.string(from: date)
  }
}

extension String {
  var mailInitials: String {
    let parts = split(separator: " ")
    let letters = parts.prefix(2).compactMap { $0.first }
    if letters.isEmpty, let first {
      return String(first).uppercased()
    }
    return String(letters).uppercased()
  }

  var htmlPlainText: String {
    replacingOccurrences(of: #"(?is)<(script|style)\b[^>]*>.*?</\1>"#, with: " ", options: .regularExpression)
      .replacingOccurrences(of: #"(?i)<br\s*/?>"#, with: "\n", options: .regularExpression)
      .replacingOccurrences(of: #"(?i)</p\s*>|</div\s*>|</li\s*>|</h[1-6]\s*>"#, with: "\n", options: .regularExpression)
      .replacingOccurrences(of: #"<[^>]+>"#, with: " ", options: .regularExpression)
      .htmlEntityDecoded
      .replacingOccurrences(of: #"[ \t\f\r]+"#, with: " ", options: .regularExpression)
      .replacingOccurrences(of: #"\n\s*\n\s*\n+"#, with: "\n\n", options: .regularExpression)
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }

  var htmlEntityDecoded: String {
    replacingOccurrences(of: "&nbsp;", with: " ")
      .replacingOccurrences(of: "&amp;", with: "&")
      .replacingOccurrences(of: "&lt;", with: "<")
      .replacingOccurrences(of: "&gt;", with: ">")
      .replacingOccurrences(of: "&quot;", with: "\"")
      .replacingOccurrences(of: "&#39;", with: "'")
  }

  var mailPreviewText: String {
    let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.range(of: #"<[a-z!/][^>]*>"#, options: [.caseInsensitive, .regularExpression]) != nil else {
      return trimmed
    }
    return trimmed.htmlPlainText
  }
}

extension MailLabel {
  var swiftUIColor: Color {
    switch color {
    case "orange": .orange
    case "green": .green
    case "blue": .blue
    case "purple": .purple
    case "red": .red
    case "yellow": .yellow
    default: .secondary
    }
  }
}
