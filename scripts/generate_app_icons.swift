#!/usr/bin/env swift

import AppKit
import Foundation
import ImageIO
import UniformTypeIdentifiers

enum IconStyle: String {
  case closed
  case open
}

struct IconSlot {
  var filename: String
  var pixels: Int
}

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let assetsURL = root.appendingPathComponent("Apps/Email/Resources/Assets.xcassets", isDirectory: true)
let defaultIconURL = assetsURL.appendingPathComponent("AppIcon.appiconset", isDirectory: true)
let openIconURL = assetsURL.appendingPathComponent("AppIconOpen.appiconset", isDirectory: true)
let defaultPreviewURL = assetsURL.appendingPathComponent("AppIconPreviewClosed.imageset", isDirectory: true)
let openPreviewURL = assetsURL.appendingPathComponent("AppIconPreviewOpen.imageset", isDirectory: true)
let sourceImageURL = root.appendingPathComponent("Apps/Email/Resources/IconSources/email-icon-concepts.png")

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
  IconSlot(filename: "Icon-Mac-16.png", pixels: 16),
  IconSlot(filename: "Icon-Mac-16@2x.png", pixels: 32),
  IconSlot(filename: "Icon-Mac-32.png", pixels: 32),
  IconSlot(filename: "Icon-Mac-32@2x.png", pixels: 64),
  IconSlot(filename: "Icon-Mac-128.png", pixels: 128),
  IconSlot(filename: "Icon-Mac-128@2x.png", pixels: 256),
  IconSlot(filename: "Icon-Mac-256.png", pixels: 256),
  IconSlot(filename: "Icon-Mac-256@2x.png", pixels: 512),
  IconSlot(filename: "Icon-Mac-512.png", pixels: 512),
  IconSlot(filename: "Icon-Mac-512@2x.png", pixels: 1024)
]

let openSlots = defaultSlots.map { slot in
  IconSlot(filename: slot.filename.replacingOccurrences(of: "Icon-", with: "Icon-Open-"), pixels: slot.pixels)
}

try FileManager.default.createDirectory(at: defaultIconURL, withIntermediateDirectories: true)
try FileManager.default.createDirectory(at: openIconURL, withIntermediateDirectories: true)
try FileManager.default.createDirectory(at: defaultPreviewURL, withIntermediateDirectories: true)
try FileManager.default.createDirectory(at: openPreviewURL, withIntermediateDirectories: true)

let sourceImage = try loadSourceImage(from: sourceImageURL)

for slot in defaultSlots {
  try writeIcon(style: .closed, pixels: slot.pixels, to: defaultIconURL.appendingPathComponent(slot.filename))
}

for slot in openSlots {
  try writeIcon(style: .open, pixels: slot.pixels, to: openIconURL.appendingPathComponent(slot.filename))
}

try writeIcon(style: .closed, pixels: 256, to: defaultPreviewURL.appendingPathComponent("preview.png"))
try writeIcon(style: .closed, pixels: 512, to: defaultPreviewURL.appendingPathComponent("preview@2x.png"))
try writeIcon(style: .open, pixels: 256, to: openPreviewURL.appendingPathComponent("preview.png"))
try writeIcon(style: .open, pixels: 512, to: openPreviewURL.appendingPathComponent("preview@2x.png"))

try contentsJSON(defaultIconURL, filenames: defaultSlots.map(\.filename))
try contentsJSON(openIconURL, filenames: openSlots.map(\.filename))
try previewContentsJSON(defaultPreviewURL)
try previewContentsJSON(openPreviewURL)

func writeIcon(style: IconStyle, pixels: Int, to url: URL) throws {
  let bytesPerRow = pixels * 4
  var bitmap = Data(repeating: 0, count: bytesPerRow * pixels)
  let image = try bitmap.withUnsafeMutableBytes { buffer -> CGImage in
    guard
      let base = buffer.baseAddress,
      let context = CGContext(
        data: base,
        width: pixels,
        height: pixels,
        bitsPerComponent: 8,
        bytesPerRow: bytesPerRow,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
      )
    else {
      throw NSError(domain: "IconGenerator", code: 1, userInfo: [NSLocalizedDescriptionKey: "Could not create bitmap context."])
    }

    let graphicsContext = NSGraphicsContext(cgContext: context, flipped: false)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = graphicsContext
    drawIcon(style: style, in: CGRect(x: 0, y: 0, width: pixels, height: pixels), context: context)
    NSGraphicsContext.restoreGraphicsState()

    guard let image = context.makeImage() else {
      throw NSError(domain: "IconGenerator", code: 2, userInfo: [NSLocalizedDescriptionKey: "Could not create image."])
    }
    return image
  }

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

func loadSourceImage(from url: URL) throws -> CGImage {
  guard
    let source = CGImageSourceCreateWithURL(url as CFURL, nil),
    let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
  else {
    throw NSError(domain: "IconGenerator", code: 5, userInfo: [NSLocalizedDescriptionKey: "Could not read source image at \(url.path)."])
  }
  return image
}

func drawIcon(style: IconStyle, in rect: CGRect, context: CGContext) {
  let side = sourceImage.width
  let cropY = style == .open ? 0 : max(0, sourceImage.height - side)
  let cropRect = CGRect(x: 0, y: cropY, width: side, height: side)
  guard let cropped = sourceImage.cropping(to: cropRect) else { return }
  context.interpolationQuality = .high
  context.draw(cropped, in: rect)
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
