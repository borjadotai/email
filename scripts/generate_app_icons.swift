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

func drawIcon(style: IconStyle, in rect: CGRect, context: CGContext) {
  context.setShouldAntialias(true)
  context.setAllowsAntialiasing(true)

  NSColor.white.setFill()
  NSBezierPath(rect: rect).fill()

  switch style {
  case .closed:
    drawClosedEnvelope(in: rect)
  case .open:
    drawOpenEnvelope(in: rect)
  }
}

func drawClosedEnvelope(in rect: CGRect) {
  let side = min(rect.width, rect.height)
  let envelope = CGRect(
    x: rect.midX - side * 0.32,
    y: rect.midY - side * 0.155,
    width: side * 0.64,
    height: side * 0.31
  )
  let radius = side * 0.035
  let lineWidth = max(1, side * 0.018)

  NSColor(calibratedWhite: 0.025, alpha: 1).setFill()
  NSBezierPath(roundedRect: envelope, xRadius: radius, yRadius: radius).fill()

  let detailColor = NSColor(calibratedWhite: 0.23, alpha: 1)
  detailColor.setStroke()
  let flap = NSBezierPath()
  flap.lineWidth = lineWidth
  flap.lineCapStyle = .round
  flap.lineJoinStyle = .round
  flap.move(to: CGPoint(x: envelope.minX + envelope.width * 0.035, y: envelope.maxY - envelope.height * 0.08))
  flap.line(to: CGPoint(x: envelope.midX, y: envelope.minY + envelope.height * 0.48))
  flap.line(to: CGPoint(x: envelope.maxX - envelope.width * 0.035, y: envelope.maxY - envelope.height * 0.08))
  flap.stroke()

  let lowerFold = NSBezierPath()
  lowerFold.lineWidth = max(1, side * 0.012)
  lowerFold.lineCapStyle = .round
  lowerFold.lineJoinStyle = .round
  lowerFold.move(to: CGPoint(x: envelope.minX + envelope.width * 0.045, y: envelope.minY + envelope.height * 0.11))
  lowerFold.line(to: CGPoint(x: envelope.midX, y: envelope.minY + envelope.height * 0.49))
  lowerFold.line(to: CGPoint(x: envelope.maxX - envelope.width * 0.045, y: envelope.minY + envelope.height * 0.11))
  lowerFold.stroke()
}

func drawOpenEnvelope(in rect: CGRect) {
  let side = min(rect.width, rect.height)
  let body = CGRect(
    x: rect.midX - side * 0.32,
    y: rect.midY - side * 0.21,
    width: side * 0.64,
    height: side * 0.30
  )
  let radius = side * 0.032
  let lineWidth = max(1, side * 0.015)

  NSColor(calibratedWhite: 0.025, alpha: 1).setFill()
  let backFlap = NSBezierPath()
  backFlap.move(to: CGPoint(x: body.minX + body.width * 0.06, y: body.maxY - body.height * 0.03))
  backFlap.line(to: CGPoint(x: body.midX, y: body.maxY + side * 0.24))
  backFlap.line(to: CGPoint(x: body.maxX - body.width * 0.06, y: body.maxY - body.height * 0.03))
  backFlap.close()
  backFlap.fill()

  NSBezierPath(roundedRect: body, xRadius: radius, yRadius: radius).fill()

  let detailColor = NSColor(calibratedWhite: 0.23, alpha: 1)
  detailColor.setStroke()
  let frontFold = NSBezierPath()
  frontFold.lineWidth = lineWidth
  frontFold.lineCapStyle = .round
  frontFold.lineJoinStyle = .round
  frontFold.move(to: CGPoint(x: body.minX + body.width * 0.045, y: body.minY + body.height * 0.12))
  frontFold.line(to: CGPoint(x: body.midX, y: body.minY + body.height * 0.56))
  frontFold.line(to: CGPoint(x: body.maxX - body.width * 0.045, y: body.minY + body.height * 0.12))
  frontFold.stroke()

  let openLip = NSBezierPath()
  openLip.lineWidth = max(1, side * 0.012)
  openLip.lineCapStyle = .round
  openLip.move(to: CGPoint(x: body.minX + body.width * 0.07, y: body.maxY - body.height * 0.08))
  openLip.line(to: CGPoint(x: body.midX, y: body.maxY + side * 0.17))
  openLip.line(to: CGPoint(x: body.maxX - body.width * 0.07, y: body.maxY - body.height * 0.08))
  openLip.stroke()
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
