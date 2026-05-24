import Foundation
import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

struct AvatarView: View {
  var name: String
  var email: String
  var urlString: String?
  var size: CGFloat = 34
  var prefersLogo: Bool = false
  @State private var loadedImage: LoadedAvatarImage?

  var body: some View {
    Group {
      if let embeddedImage = AvatarDataURL.loadedImage(from: urlString) {
        imageContent(Image(platformImage: embeddedImage.image))
          .task(id: urlString) {
            loadedImage = embeddedImage
          }
      } else if let urlString, let url = URL(string: urlString) {
        Group {
          if let loadedImage {
            imageContent(Image(platformImage: loadedImage.image))
          } else {
            fallback
          }
        }
        .task(id: url) {
          await loadImage(from: url)
        }
      } else {
        fallback
          .task(id: urlString) {
            loadedImage = nil
          }
      }
    }
    .frame(width: size, height: size)
    .background(
      RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        .fill(tileFill)
    )
    .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
    .overlay {
      RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        .stroke(tileStroke, lineWidth: 0.5)
    }
    .accessibilityHidden(true)
  }

  private func loadImage(from url: URL) async {
    loadedImage = nil
    do {
      loadedImage = try await AvatarImageCache.shared.image(for: url)
    } catch {
      loadedImage = nil
    }
  }

  @ViewBuilder
  private func imageContent(_ image: Image) -> some View {
    if prefersLogo {
      image
        .resizable()
        .scaledToFit()
        .padding(size * 0.16)
    } else {
      image
        .resizable()
        .scaledToFill()
    }
  }

  private var fallback: some View {
    ZStack {
      RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        .fill(.quaternary)
      Text((name.isEmpty ? email : name).mailInitials)
        .font(.system(size: size * 0.34, weight: .semibold))
        .foregroundStyle(.secondary)
    }
  }

  private var cornerRadius: CGFloat {
    min(8, size * 0.24)
  }

  private var tileFill: Color {
    guard prefersLogo else { return .clear }
    return loadedImage?.backgroundColor ?? Color.secondary.opacity(0.10)
  }

  private var tileStroke: Color {
    prefersLogo ? Color.primary.opacity(0.08) : .clear
  }
}

private struct LoadedAvatarImage {
  var image: PlatformImage
  var backgroundColor: Color?
}

private enum AvatarDataURL {
  static func loadedImage(from value: String?) -> LoadedAvatarImage? {
    guard
      let value,
      value.lowercased().hasPrefix("data:image/"),
      let commaIndex = value.firstIndex(of: ",")
    else {
      return nil
    }

    let metadata = value[..<commaIndex].lowercased()
    let payload = String(value[value.index(after: commaIndex)...])
    let data: Data?
    if metadata.contains(";base64") {
      data = Data(base64Encoded: payload)
    } else {
      data = payload.removingPercentEncoding?.data(using: .utf8)
    }

    guard let data, let image = PlatformImage(data: data) else {
      return nil
    }

    return LoadedAvatarImage(
      image: image,
      backgroundColor: AvatarBackgroundSampler.backgroundColor(from: image)
    )
  }
}

@MainActor
private final class AvatarImageCache {
  static let shared = AvatarImageCache()

  private var cache: [URL: LoadedAvatarImage] = [:]

  func image(for url: URL) async throws -> LoadedAvatarImage {
    if let cached = cache[url] {
      return cached
    }

    let (data, response) = try await URLSession.shared.data(from: url)
    if let httpResponse = response as? HTTPURLResponse, !(200..<300).contains(httpResponse.statusCode) {
      throw URLError(.badServerResponse)
    }

    guard let image = PlatformImage(data: data) else {
      throw URLError(.cannotDecodeContentData)
    }

    let loaded = LoadedAvatarImage(
      image: image,
      backgroundColor: AvatarBackgroundSampler.backgroundColor(from: image)
    )
    cache[url] = loaded
    return loaded
  }
}

#if os(macOS)
private typealias PlatformImage = NSImage

private extension Image {
  init(platformImage: PlatformImage) {
    self.init(nsImage: platformImage)
  }
}

private extension NSImage {
  var avatarCGImage: CGImage? {
    var proposedRect = CGRect(origin: .zero, size: size)
    return cgImage(forProposedRect: &proposedRect, context: nil, hints: nil)
  }
}
#else
private typealias PlatformImage = UIImage

private extension Image {
  init(platformImage: PlatformImage) {
    self.init(uiImage: platformImage)
  }
}

private extension UIImage {
  var avatarCGImage: CGImage? {
    cgImage
  }
}
#endif

private enum AvatarBackgroundSampler {
  static func backgroundColor(from image: PlatformImage) -> Color? {
    guard let cgImage = image.avatarCGImage else {
      return nil
    }

    let sample = RasterSample(cgImage: cgImage, maxDimension: 36)
    guard let sample else {
      return nil
    }

    if let edgeColor = dominantColor(in: sample.edgePixels, minimumCoverage: 0.16) {
      return edgeColor.color
    }

    guard let visibleColor = dominantColor(in: sample.visiblePixels, minimumCoverage: 0.12) else {
      return nil
    }

    return visibleColor.coverage < 0.26
      ? visibleColor.color.opacity(0.16)
      : visibleColor.color
  }

  private static func dominantColor(in pixels: [SampledPixel], minimumCoverage: Double) -> DominantColor? {
    guard !pixels.isEmpty else {
      return nil
    }

    var buckets: [Int: ColorBucket] = [:]
    var totalWeight = 0

    for pixel in pixels {
      let key = pixel.quantizedKey
      buckets[key, default: ColorBucket()].add(pixel)
      totalWeight += pixel.weight
    }

    guard totalWeight > 0, let bucket = buckets.values.max(by: { $0.weight < $1.weight }) else {
      return nil
    }

    let coverage = Double(bucket.weight) / Double(totalWeight)
    guard coverage >= minimumCoverage else {
      return nil
    }

    return DominantColor(color: bucket.color, coverage: coverage)
  }
}

private struct RasterSample {
  var edgePixels: [SampledPixel]
  var visiblePixels: [SampledPixel]

  init?(cgImage: CGImage, maxDimension: Int) {
    let largestDimension = max(cgImage.width, cgImage.height)
    guard largestDimension > 0 else {
      return nil
    }

    let scale = min(1, Double(maxDimension) / Double(largestDimension))
    let width = max(1, Int(Double(cgImage.width) * scale))
    let height = max(1, Int(Double(cgImage.height) * scale))
    let bytesPerPixel = 4
    let bytesPerRow = width * bytesPerPixel
    var data = [UInt8](repeating: 0, count: height * bytesPerRow)

    guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
          let context = CGContext(
            data: &data,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: bytesPerRow,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
          ) else {
      return nil
    }

    context.interpolationQuality = .medium
    context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))

    var edgePixels: [SampledPixel] = []
    var visiblePixels: [SampledPixel] = []
    let edgeBand = max(1, min(width, height) / 8)

    for y in 0..<height {
      for x in 0..<width {
        let offset = y * bytesPerRow + x * bytesPerPixel
        guard let pixel = SampledPixel(
          red: data[offset],
          green: data[offset + 1],
          blue: data[offset + 2],
          alpha: data[offset + 3]
        ) else {
          continue
        }

        visiblePixels.append(pixel)
        if x < edgeBand || y < edgeBand || x >= width - edgeBand || y >= height - edgeBand {
          edgePixels.append(pixel)
        }
      }
    }

    self.edgePixels = edgePixels
    self.visiblePixels = visiblePixels
  }
}

private struct SampledPixel {
  var red: Int
  var green: Int
  var blue: Int
  var weight: Int

  init?(red: UInt8, green: UInt8, blue: UInt8, alpha: UInt8) {
    let alphaValue = Int(alpha)
    guard alphaValue > 24 else {
      return nil
    }

    self.red = min(255, Int(red) * 255 / alphaValue)
    self.green = min(255, Int(green) * 255 / alphaValue)
    self.blue = min(255, Int(blue) * 255 / alphaValue)
    self.weight = alphaValue
  }

  var quantizedKey: Int {
    (red / 24) << 16 | (green / 24) << 8 | (blue / 24)
  }
}

private struct ColorBucket {
  var red = 0
  var green = 0
  var blue = 0
  var weight = 0

  mutating func add(_ pixel: SampledPixel) {
    red += pixel.red * pixel.weight
    green += pixel.green * pixel.weight
    blue += pixel.blue * pixel.weight
    weight += pixel.weight
  }

  var color: Color {
    let safeWeight = max(weight, 1)
    return Color(
      red: Double(red) / Double(safeWeight) / 255,
      green: Double(green) / Double(safeWeight) / 255,
      blue: Double(blue) / Double(safeWeight) / 255
    )
  }
}

private struct DominantColor {
  var color: Color
  var coverage: Double
}
