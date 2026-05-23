import SwiftUI

struct LabelChip: View {
  var label: MailLabel

  var body: some View {
    Text(label.name)
      .font(.caption2.weight(.medium))
      .lineLimit(1)
      .padding(.horizontal, 7)
      .padding(.vertical, 3)
      .background(label.swiftUIColor.opacity(0.14), in: Capsule())
      .foregroundStyle(label.swiftUIColor)
  }
}

