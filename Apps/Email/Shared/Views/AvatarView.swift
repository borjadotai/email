import SwiftUI

struct AvatarView: View {
  var name: String
  var email: String
  var urlString: String?
  var size: CGFloat = 34

  var body: some View {
    Group {
      if let urlString, let url = URL(string: urlString) {
        AsyncImage(url: url) { phase in
          switch phase {
          case .success(let image):
            image
              .resizable()
              .scaledToFill()
          default:
            fallback
          }
        }
      } else {
        fallback
      }
    }
    .frame(width: size, height: size)
    .clipShape(Circle())
    .accessibilityHidden(true)
  }

  private var fallback: some View {
    ZStack {
      Circle()
        .fill(.quaternary)
      Text((name.isEmpty ? email : name).mailInitials)
        .font(.system(size: size * 0.34, weight: .semibold))
        .foregroundStyle(.secondary)
    }
  }
}

