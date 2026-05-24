import SwiftUI

struct LabelChip: View {
  var label: MailLabel

  var body: some View {
    HStack(spacing: 4) {
      Image(systemName: label.systemImage)
        .font(.caption2.weight(.semibold))

      Text(label.name)
        .lineLimit(1)
    }
    .font(.caption2.weight(.medium))
    .padding(.horizontal, 7)
    .padding(.vertical, 3)
    .background(label.swiftUIColor.opacity(0.14), in: Capsule())
    .foregroundStyle(label.swiftUIColor)
  }
}
