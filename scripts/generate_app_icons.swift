#!/usr/bin/env swift

import AppKit
import Foundation
import ImageIO
import UniformTypeIdentifiers

enum IconStyle: String {
  case closed
  case open
}

enum IconPlatform {
  case iOS
  case macOS
}

enum IconPalette {
  case blackEnvelope
  case whiteEnvelope
}

struct IconSlot {
  var filename: String
  var pixels: Int
  var platform: IconPlatform = .iOS
}

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let assetsURL = root.appendingPathComponent("Apps/Email/Resources/Assets.xcassets", isDirectory: true)
let iconSourcesURL = root.appendingPathComponent("Apps/Email/Resources/IconSources", isDirectory: true)
let defaultIconURL = assetsURL.appendingPathComponent("AppIcon.appiconset", isDirectory: true)
let openIconURL = assetsURL.appendingPathComponent("AppIconOpen.appiconset", isDirectory: true)
let closedWhiteIconURL = assetsURL.appendingPathComponent("AppIconClosedWhite.appiconset", isDirectory: true)
let openWhiteIconURL = assetsURL.appendingPathComponent("AppIconOpenWhite.appiconset", isDirectory: true)
let defaultPreviewURL = assetsURL.appendingPathComponent("AppIconPreviewClosed.imageset", isDirectory: true)
let openPreviewURL = assetsURL.appendingPathComponent("AppIconPreviewOpen.imageset", isDirectory: true)
let closedWhitePreviewURL = assetsURL.appendingPathComponent("AppIconPreviewClosedWhite.imageset", isDirectory: true)
let openWhitePreviewURL = assetsURL.appendingPathComponent("AppIconPreviewOpenWhite.imageset", isDirectory: true)

let defaultSlots = [
  IconSlot(filename: "Icon-iPhone-20@2x.png", pixels: 40),
  IconSlot(filename: "Icon-iPhone-20@3x.png", pixels: 60),
  IconSlot(filename: "Icon-iPhone-29@2x.png", pixels: 58),
  IconSlot(filename: "Icon-iPhone-29@3x.png", pixels: 87),
  IconSlot(filename: "Icon-iPhone-40@2x.png", pixels: 80),
  IconSlot(filename: "Icon-iPhone-40@3x.png", pixels: 120),
  IconSlot(filename: "Icon-iPhone-60@2x.png", pixels: 120),
  IconSlot(filename: "Icon-iPhone-60@3x.png", pixels: 180),
  IconSlot(filename: "Icon-iPad-20.png", pixels: 20),
  IconSlot(filename: "Icon-iPad-20@2x.png", pixels: 40),
  IconSlot(filename: "Icon-iPad-29.png", pixels: 29),
  IconSlot(filename: "Icon-iPad-29@2x.png", pixels: 58),
  IconSlot(filename: "Icon-iPad-40.png", pixels: 40),
  IconSlot(filename: "Icon-iPad-40@2x.png", pixels: 80),
  IconSlot(filename: "Icon-iPad-76.png", pixels: 76),
  IconSlot(filename: "Icon-iPad-76@2x.png", pixels: 152),
  IconSlot(filename: "Icon-iPad-83.5@2x.png", pixels: 167),
  IconSlot(filename: "Icon-AppStore.png", pixels: 1024),
  IconSlot(filename: "Icon-Mac-16.png", pixels: 16, platform: .macOS),
  IconSlot(filename: "Icon-Mac-16@2x.png", pixels: 32, platform: .macOS),
  IconSlot(filename: "Icon-Mac-32.png", pixels: 32, platform: .macOS),
  IconSlot(filename: "Icon-Mac-32@2x.png", pixels: 64, platform: .macOS),
  IconSlot(filename: "Icon-Mac-128.png", pixels: 128, platform: .macOS),
  IconSlot(filename: "Icon-Mac-128@2x.png", pixels: 256, platform: .macOS),
  IconSlot(filename: "Icon-Mac-256.png", pixels: 256, platform: .macOS),
  IconSlot(filename: "Icon-Mac-256@2x.png", pixels: 512, platform: .macOS),
  IconSlot(filename: "Icon-Mac-512.png", pixels: 512, platform: .macOS),
  IconSlot(filename: "Icon-Mac-512@2x.png", pixels: 1024, platform: .macOS)
]

let openSlots = defaultSlots.map { slot in
  IconSlot(filename: slot.filename.replacingOccurrences(of: "Icon-", with: "Icon-Open-"), pixels: slot.pixels, platform: slot.platform)
}
let closedWhiteSlots = defaultSlots.map { slot in
  IconSlot(filename: slot.filename.replacingOccurrences(of: "Icon-", with: "Icon-Closed-White-"), pixels: slot.pixels, platform: slot.platform)
}
let openWhiteSlots = defaultSlots.map { slot in
  IconSlot(filename: slot.filename.replacingOccurrences(of: "Icon-", with: "Icon-Open-White-"), pixels: slot.pixels, platform: slot.platform)
}

try FileManager.default.createDirectory(at: defaultIconURL, withIntermediateDirectories: true)
try FileManager.default.createDirectory(at: openIconURL, withIntermediateDirectories: true)
try FileManager.default.createDirectory(at: closedWhiteIconURL, withIntermediateDirectories: true)
try FileManager.default.createDirectory(at: openWhiteIconURL, withIntermediateDirectories: true)
try FileManager.default.createDirectory(at: defaultPreviewURL, withIntermediateDirectories: true)
try FileManager.default.createDirectory(at: openPreviewURL, withIntermediateDirectories: true)
try FileManager.default.createDirectory(at: closedWhitePreviewURL, withIntermediateDirectories: true)
try FileManager.default.createDirectory(at: openWhitePreviewURL, withIntermediateDirectories: true)

let closedEnvelopeArtwork = try loadEnvelopeArtwork(named: "email-envelope-closed.png")
let openEnvelopeArtwork = try loadEnvelopeArtwork(named: "email-envelope-open.png")

try writePNG(closedEnvelopeArtwork.whiteImage, to: iconSourcesURL.appendingPathComponent("email-envelope-closed-white.png"))
try writePNG(openEnvelopeArtwork.whiteImage, to: iconSourcesURL.appendingPathComponent("email-envelope-open-white.png"))

for slot in defaultSlots {
  try writeIcon(style: .closed, palette: .blackEnvelope, pixels: slot.pixels, platform: slot.platform, to: defaultIconURL.appendingPathComponent(slot.filename))
}

for slot in openSlots {
  try writeIcon(style: .open, palette: .blackEnvelope, pixels: slot.pixels, platform: slot.platform, to: openIconURL.appendingPathComponent(slot.filename))
}

for slot in closedWhiteSlots {
  try writeIcon(style: .closed, palette: .whiteEnvelope, pixels: slot.pixels, platform: slot.platform, to: closedWhiteIconURL.appendingPathComponent(slot.filename))
}

for slot in openWhiteSlots {
  try writeIcon(style: .open, palette: .whiteEnvelope, pixels: slot.pixels, platform: slot.platform, to: openWhiteIconURL.appendingPathComponent(slot.filename))
}

try writeIcon(style: .closed, palette: .blackEnvelope, pixels: 256, platform: .macOS, to: defaultPreviewURL.appendingPathComponent("preview.png"))
try writeIcon(style: .closed, palette: .blackEnvelope, pixels: 512, platform: .macOS, to: defaultPreviewURL.appendingPathComponent("preview@2x.png"))
try writeIcon(style: .open, palette: .blackEnvelope, pixels: 256, platform: .macOS, to: openPreviewURL.appendingPathComponent("preview.png"))
try writeIcon(style: .open, palette: .blackEnvelope, pixels: 512, platform: .macOS, to: openPreviewURL.appendingPathComponent("preview@2x.png"))
try writeIcon(style: .closed, palette: .whiteEnvelope, pixels: 256, platform: .macOS, to: closedWhitePreviewURL.appendingPathComponent("preview.png"))
try writeIcon(style: .closed, palette: .whiteEnvelope, pixels: 512, platform: .macOS, to: closedWhitePreviewURL.appendingPathComponent("preview@2x.png"))
try writeIcon(style: .open, palette: .whiteEnvelope, pixels: 256, platform: .macOS, to: openWhitePreviewURL.appendingPathComponent("preview.png"))
try writeIcon(style: .open, palette: .whiteEnvelope, pixels: 512, platform: .macOS, to: openWhitePreviewURL.appendingPathComponent("preview@2x.png"))

try contentsJSON(defaultIconURL, filenames: defaultSlots.map(\.filename))
try contentsJSON(openIconURL, filenames: openSlots.map(\.filename))
try contentsJSON(closedWhiteIconURL, filenames: closedWhiteSlots.map(\.filename))
try contentsJSON(openWhiteIconURL, filenames: openWhiteSlots.map(\.filename))
try previewContentsJSON(defaultPreviewURL)
try previewContentsJSON(openPreviewURL)
try previewContentsJSON(closedWhitePreviewURL)
try previewContentsJSON(openWhitePreviewURL)

func writeIcon(style: IconStyle, palette: IconPalette, pixels: Int, platform: IconPlatform, to url: URL) throws {
  let bytesPerRow = pixels * 4
  var bitmap = Data(repeating: 0, count: bytesPerRow * pixels)
  let image = try bitmap.withUnsafeMutableBytes { buffer -> CGImage in
    let alphaInfo: CGImageAlphaInfo = platform == .macOS ? .premultipliedLast : .noneSkipLast
    guard
      let base = buffer.baseAddress,
      let context = CGContext(
        data: base,
        width: pixels,
        height: pixels,
        bitsPerComponent: 8,
        bytesPerRow: bytesPerRow,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: alphaInfo.rawValue
      )
    else {
      throw NSError(domain: "IconGenerator", code: 1, userInfo: [NSLocalizedDescriptionKey: "Could not create bitmap context."])
    }

    let graphicsContext = NSGraphicsContext(cgContext: context, flipped: false)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = graphicsContext
    drawIcon(style: style, palette: palette, platform: platform, in: CGRect(x: 0, y: 0, width: pixels, height: pixels), context: context)
    NSGraphicsContext.restoreGraphicsState()

    guard let image = context.makeImage() else {
      throw NSError(domain: "IconGenerator", code: 2, userInfo: [NSLocalizedDescriptionKey: "Could not create image."])
    }
    return image
  }

  try writePNG(image, to: url)
}

func writePNG(_ image: CGImage, to url: URL) throws {
  let data = NSMutableData()
  guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else {
    throw NSError(domain: "IconGenerator", code: 3, userInfo: [NSLocalizedDescriptionKey: "Could not create PNG destination."])
  }
  CGImageDestinationAddImage(destination, image, nil)
  guard CGImageDestinationFinalize(destination) else {
    throw NSError(domain: "IconGenerator", code: 4, userInfo: [NSLocalizedDescriptionKey: "Could not encode PNG."])
  }
  try (data as Data).write(to: url)
}

func drawIcon(style: IconStyle, palette: IconPalette, platform: IconPlatform, in rect: CGRect, context: CGContext) {
  context.setShouldAntialias(true)
  context.setAllowsAntialiasing(true)

  let contentRect = drawIconSurface(palette: palette, platform: platform, in: rect)
  drawEnvelopeArtwork(envelopeArtwork(for: style), style: style, palette: palette, platform: platform, in: contentRect)
}

@discardableResult
func drawIconSurface(palette: IconPalette, platform: IconPlatform, in rect: CGRect) -> CGRect {
  let side = min(rect.width, rect.height)
  let lineWidth = max(1, side * 0.006)
  let surfaceRect: CGRect
  let radius: CGFloat

  switch platform {
  case .iOS:
    NSColor(calibratedWhite: palette == .blackEnvelope ? 1 : 0, alpha: 1).setFill()
    NSBezierPath(rect: rect).fill()
    surfaceRect = rect.insetBy(dx: lineWidth * 0.5, dy: lineWidth * 0.5)
    radius = side * 0.218
  case .macOS:
    surfaceRect = rect.insetBy(dx: side * 0.08, dy: side * 0.08)
    radius = side * 0.235
  }

  let surface = NSBezierPath(roundedRect: surfaceRect, xRadius: radius, yRadius: radius)
  let fillGradient: NSGradient
  let strokeColor: NSColor
  let innerHighlightColor: NSColor

  switch palette {
  case .blackEnvelope:
    fillGradient = NSGradient(colors: [
      NSColor(calibratedWhite: 1, alpha: 1),
      NSColor(calibratedWhite: 0.965, alpha: 1)
    ])!
    strokeColor = NSColor(calibratedWhite: 0.84, alpha: 1)
    innerHighlightColor = NSColor(calibratedWhite: 1, alpha: 0.55)
  case .whiteEnvelope:
    fillGradient = NSGradient(colors: [
      NSColor(calibratedWhite: 0.025, alpha: 1),
      NSColor(calibratedWhite: 0, alpha: 1)
    ])!
    strokeColor = NSColor(calibratedWhite: 0.16, alpha: 1)
    innerHighlightColor = NSColor(calibratedWhite: 1, alpha: 0.10)
  }
  fill(surface, with: fillGradient, angle: 90)

  strokeColor.setStroke()
  surface.lineWidth = lineWidth
  surface.stroke()

  let innerHighlight = NSBezierPath(roundedRect: surfaceRect.insetBy(dx: lineWidth * 2, dy: lineWidth * 2), xRadius: max(0, radius - lineWidth * 2), yRadius: max(0, radius - lineWidth * 2))
  innerHighlightColor.setStroke()
  innerHighlight.lineWidth = max(1, lineWidth * 0.5)
  innerHighlight.stroke()

  return surfaceRect
}

func fill(_ path: NSBezierPath, with gradient: NSGradient, angle: CGFloat) {
  NSGraphicsContext.saveGraphicsState()
  path.addClip()
  gradient.draw(in: path.bounds, angle: angle)
  NSGraphicsContext.restoreGraphicsState()
}

struct EnvelopeArtwork {
  let blackImage: NSImage
  let whiteImage: CGImage
  let whitePreviewImage: NSImage
  let size: CGSize
}

func loadEnvelopeArtwork(named filename: String) throws -> EnvelopeArtwork {
  let url = iconSourcesURL.appendingPathComponent(filename)
  guard let sourceImage = NSImage(contentsOf: url) else {
    throw NSError(domain: "IconGenerator", code: 5, userInfo: [NSLocalizedDescriptionKey: "Could not load envelope artwork at \(url.path)."])
  }

  var proposedRect = CGRect(origin: .zero, size: sourceImage.size)
  guard let sourceCGImage = sourceImage.cgImage(forProposedRect: &proposedRect, context: nil, hints: nil) else {
    throw NSError(domain: "IconGenerator", code: 6, userInfo: [NSLocalizedDescriptionKey: "Could not decode envelope artwork at \(url.path)."])
  }

  let keyedCGImage = try makeWhiteBackgroundTransparent(sourceCGImage)
  let whiteCGImage = try invertArtwork(keyedCGImage)
  let pixelSize = CGSize(width: keyedCGImage.width, height: keyedCGImage.height)
  let blackImage = NSImage(cgImage: keyedCGImage, size: pixelSize)
  let whiteImage = NSImage(cgImage: whiteCGImage, size: pixelSize)
  return EnvelopeArtwork(blackImage: blackImage, whiteImage: whiteCGImage, whitePreviewImage: whiteImage, size: pixelSize)
}

func makeWhiteBackgroundTransparent(_ sourceImage: CGImage) throws -> CGImage {
  let width = sourceImage.width
  let height = sourceImage.height
  let bytesPerRow = width * 4
  var pixels = Data(repeating: 0, count: bytesPerRow * height)

  return try pixels.withUnsafeMutableBytes { buffer -> CGImage in
    guard
      let base = buffer.baseAddress,
      let context = CGContext(
        data: base,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: bytesPerRow,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
      )
    else {
      throw NSError(domain: "IconGenerator", code: 7, userInfo: [NSLocalizedDescriptionKey: "Could not create artwork bitmap context."])
    }

    context.draw(sourceImage, in: CGRect(x: 0, y: 0, width: width, height: height))

    let bytes = buffer.bindMemory(to: UInt8.self)
    for offset in stride(from: 0, to: bytes.count, by: 4) {
      let alpha = keyedAlpha(red: bytes[offset], green: bytes[offset + 1], blue: bytes[offset + 2])
      if alpha < 255 {
        bytes[offset] = UInt8(Int(bytes[offset]) * Int(alpha) / 255)
        bytes[offset + 1] = UInt8(Int(bytes[offset + 1]) * Int(alpha) / 255)
        bytes[offset + 2] = UInt8(Int(bytes[offset + 2]) * Int(alpha) / 255)
      }
      bytes[offset + 3] = alpha
    }

    guard let keyedImage = context.makeImage() else {
      throw NSError(domain: "IconGenerator", code: 8, userInfo: [NSLocalizedDescriptionKey: "Could not create keyed artwork image."])
    }
    return keyedImage
  }
}

func invertArtwork(_ sourceImage: CGImage) throws -> CGImage {
  let width = sourceImage.width
  let height = sourceImage.height
  let bytesPerRow = width * 4
  var pixels = Data(repeating: 0, count: bytesPerRow * height)

  return try pixels.withUnsafeMutableBytes { buffer -> CGImage in
    guard
      let base = buffer.baseAddress,
      let context = CGContext(
        data: base,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: bytesPerRow,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
      )
    else {
      throw NSError(domain: "IconGenerator", code: 9, userInfo: [NSLocalizedDescriptionKey: "Could not create inverted artwork bitmap context."])
    }

    context.draw(sourceImage, in: CGRect(x: 0, y: 0, width: width, height: height))

    let bytes = buffer.bindMemory(to: UInt8.self)
    for offset in stride(from: 0, to: bytes.count, by: 4) {
      let alpha = bytes[offset + 3]
      guard alpha > 0 else {
        bytes[offset] = 0
        bytes[offset + 1] = 0
        bytes[offset + 2] = 0
        continue
      }

      let sourceRed = min(255, Int(bytes[offset]) * 255 / Int(alpha))
      let sourceGreen = min(255, Int(bytes[offset + 1]) * 255 / Int(alpha))
      let sourceBlue = min(255, Int(bytes[offset + 2]) * 255 / Int(alpha))
      bytes[offset] = UInt8((255 - sourceRed) * Int(alpha) / 255)
      bytes[offset + 1] = UInt8((255 - sourceGreen) * Int(alpha) / 255)
      bytes[offset + 2] = UInt8((255 - sourceBlue) * Int(alpha) / 255)
    }

    guard let invertedImage = context.makeImage() else {
      throw NSError(domain: "IconGenerator", code: 10, userInfo: [NSLocalizedDescriptionKey: "Could not create inverted artwork image."])
    }
    return invertedImage
  }
}

func keyedAlpha(red: UInt8, green: UInt8, blue: UInt8) -> UInt8 {
  let minimum = min(red, min(green, blue))
  let maximum = max(red, max(green, blue))
  let spread = maximum - minimum

  guard minimum > 205, spread < 24 else {
    return 255
  }

  if minimum >= 236 {
    return 0
  }

  let opacity = min(0.65, max(0, Double(236 - minimum) / 31))
  return UInt8(opacity * 255)
}

func envelopeArtwork(for style: IconStyle) -> EnvelopeArtwork {
  switch style {
  case .closed:
    return closedEnvelopeArtwork
  case .open:
    return openEnvelopeArtwork
  }
}

func drawEnvelopeArtwork(_ artwork: EnvelopeArtwork, style: IconStyle, palette: IconPalette, platform: IconPlatform, in rect: CGRect) {
  let side = min(rect.width, rect.height)
  let aspectRatio = artwork.size.width / artwork.size.height
  let maxWidth: CGFloat
  let maxHeight: CGFloat

  switch (platform, style) {
  case (.macOS, .closed):
    maxWidth = side * 0.66
    maxHeight = side * 0.48
  case (.macOS, .open):
    maxWidth = side * 0.64
    maxHeight = side * 0.70
  case (.iOS, .closed):
    maxWidth = side * 0.74
    maxHeight = side * 0.52
  case (.iOS, .open):
    maxWidth = side * 0.70
    maxHeight = side * 0.74
  }

  var drawWidth = maxWidth
  var drawHeight = drawWidth / aspectRatio

  if drawHeight > maxHeight {
    drawHeight = maxHeight
    drawWidth = drawHeight * aspectRatio
  }

  let targetRect = CGRect(
    x: rect.midX - drawWidth / 2,
    y: rect.midY - drawHeight / 2,
    width: drawWidth,
    height: drawHeight
  )

  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current?.imageInterpolation = .high
  let image = palette == .blackEnvelope ? artwork.blackImage : artwork.whitePreviewImage
  image.draw(
    in: targetRect,
    from: CGRect(origin: .zero, size: artwork.size),
    operation: .sourceOver,
    fraction: 1
  )
  NSGraphicsContext.restoreGraphicsState()
}

func contentsJSON(_ url: URL, filenames: [String]) throws {
  let source = try String(contentsOf: defaultIconURL.appendingPathComponent("Contents.json"), encoding: .utf8)
  var output = source
  for (defaultSlot, filename) in zip(defaultSlots, filenames) {
    output = output.replacingOccurrences(of: "\"filename\": \"\(defaultSlot.filename)\"", with: "\"filename\": \"\(filename)\"")
  }
  try output.write(to: url.appendingPathComponent("Contents.json"), atomically: true, encoding: .utf8)
}

func previewContentsJSON(_ url: URL) throws {
  let json = """
  {
    "images": [
      {
        "filename": "preview.png",
        "idiom": "universal",
        "scale": "1x"
      },
      {
        "filename": "preview@2x.png",
        "idiom": "universal",
        "scale": "2x"
      }
    ],
    "info": {
      "author": "xcode",
      "version": 1
    }
  }
  """
  try json.write(to: url.appendingPathComponent("Contents.json"), atomically: true, encoding: .utf8)
}
