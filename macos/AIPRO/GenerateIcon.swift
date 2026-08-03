import CoreGraphics
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers

guard CommandLine.arguments.count == 2 else {
    fputs("usage: GenerateIcon.swift <iconset-directory>\n", stderr)
    exit(2)
}

let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

let outputs: [(String, Int)] = [
    ("icon_16x16.png", 16), ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32), ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128), ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256), ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512), ("icon_512x512@2x.png", 1024),
]

func render(size: Int, to url: URL) throws {
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    let bytesPerRow = size * 4
    var pixels = [UInt8](repeating: 0, count: bytesPerRow * size)
    guard let context = CGContext(
        data: &pixels,
        width: size,
        height: size,
        bitsPerComponent: 8,
        bytesPerRow: bytesPerRow,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { throw NSError(domain: "AIPROIcon", code: 1) }

    context.setAllowsAntialiasing(true)
    context.setShouldAntialias(true)
    let side = CGFloat(size)
    let inset = side * 0.055
    let rect = CGRect(x: inset, y: inset, width: side - inset * 2, height: side - inset * 2)
    let background = CGPath(roundedRect: rect, cornerWidth: side * 0.225,
                            cornerHeight: side * 0.225, transform: nil)
    context.saveGState()
    context.addPath(background)
    context.clip()
    let colors = [
        CGColor(red: 0.20, green: 0.14, blue: 0.54, alpha: 1),
        CGColor(red: 0.35, green: 0.30, blue: 0.96, alpha: 1),
        CGColor(red: 0.08, green: 0.70, blue: 0.96, alpha: 1),
    ] as CFArray
    let gradient = CGGradient(colorsSpace: colorSpace, colors: colors, locations: [0, 0.55, 1])!
    context.drawLinearGradient(gradient, start: CGPoint(x: inset, y: side - inset),
                               end: CGPoint(x: side - inset, y: inset), options: [])
    context.setFillColor(CGColor(gray: 1, alpha: 0.11))
    context.fillEllipse(in: CGRect(x: side * 0.05, y: side * 0.48,
                                   width: side * 0.76, height: side * 0.58))
    context.restoreGState()

    let font = CTFontCreateWithName(".AppleSystemUIFontHeavy" as CFString, side * 0.34, nil)
    let attributes: [NSAttributedString.Key: Any] = [
        NSAttributedString.Key(kCTFontAttributeName as String): font,
        NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: 1, alpha: 1),
        NSAttributedString.Key(kCTKernAttributeName as String): -side * 0.018,
    ]
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: "AI", attributes: attributes))
    let bounds = CTLineGetBoundsWithOptions(line, [.useOpticalBounds])
    context.textPosition = CGPoint(x: (side - bounds.width) / 2 - bounds.minX,
                                   y: (side - bounds.height) / 2 - bounds.minY - side * 0.01)
    CTLineDraw(line, context)

    context.setFillColor(CGColor(red: 0.35, green: 1.0, blue: 0.70, alpha: 1))
    context.fillEllipse(in: CGRect(x: side * 0.73, y: side * 0.73,
                                   width: side * 0.105, height: side * 0.105))

    guard let image = context.makeImage(),
          let destination = CGImageDestinationCreateWithURL(
            url as CFURL, UTType.png.identifier as CFString, 1, nil
          ) else { throw NSError(domain: "AIPROIcon", code: 2) }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else {
        throw NSError(domain: "AIPROIcon", code: 3)
    }
}

for (name, size) in outputs {
    try render(size: size, to: directory.appendingPathComponent(name))
}
