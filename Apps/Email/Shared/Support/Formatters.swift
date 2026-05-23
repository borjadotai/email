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
