import Foundation
import Vision
import ImageIO
import CoreGraphics

struct Word: Codable {
    let text: String
    let confidence: Float
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct Badge: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct VisionResult: Codable {
    let ok: Bool
    let imageWidth: Int
    let imageHeight: Int
    let words: [Word]
    let redBadges: [Badge]
}

struct WindowInfo: Codable {
    let ok: Bool
    let windowId: UInt32
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

func fail(_ message: String) -> Never {
    let payload = ["ok": false, "error": message] as [String: Any]
    let data = try! JSONSerialization.data(withJSONObject: payload)
    FileHandle.standardOutput.write(data)
    exit(1)
}

if CommandLine.arguments.count == 4 && CommandLine.arguments[1] == "click" {
    guard let x = Double(CommandLine.arguments[2]), let y = Double(CommandLine.arguments[3]) else {
        fail("invalid_click_point")
    }
    let point = CGPoint(x: x, y: y)
    guard let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown,
                             mouseCursorPosition: point, mouseButton: .left),
          let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp,
                           mouseCursorPosition: point, mouseButton: .left) else {
        fail("click_event_unavailable")
    }
    down.post(tap: .cghidEventTap)
    usleep(50_000)
    up.post(tap: .cghidEventTap)
    FileHandle.standardOutput.write(Data("{\"ok\":true}".utf8))
    exit(0)
}

if CommandLine.arguments.count == 2 && CommandLine.arguments[1] == "window-info" {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
    for window in windows {
        guard ["WeChat", "微信"].contains(window[kCGWindowOwnerName as String] as? String ?? ""),
              (window[kCGWindowLayer as String] as? Int) == 0,
              let number = window[kCGWindowNumber as String] as? UInt32,
              let rawBounds = window[kCGWindowBounds as String] as? [String: Any],
              let bounds = CGRect(dictionaryRepresentation: rawBounds as CFDictionary),
              bounds.width >= 500, bounds.height >= 300 else { continue }
        let payload = WindowInfo(ok: true, windowId: number, x: bounds.origin.x,
                                 y: bounds.origin.y, width: bounds.width, height: bounds.height)
        FileHandle.standardOutput.write(try! JSONEncoder().encode(payload))
        exit(0)
    }
    fail("wechat_window_unavailable")
}

guard CommandLine.arguments.count == 2 else { fail("usage: wechat-poc-vision <image>|window-info") }
let imageURL = URL(fileURLWithPath: CommandLine.arguments[1])
guard let source = CGImageSourceCreateWithURL(imageURL as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    fail("image could not be loaded")
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["zh-Hans", "en-US"]
request.usesLanguageCorrection = false

do {
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
} catch {
    fail("recognition failed: \(error.localizedDescription)")
}

let words: [Word] = (request.results ?? []).compactMap { observation in
    guard let candidate = observation.topCandidates(1).first else { return nil }
    let box = observation.boundingBox
    return Word(
        text: candidate.string,
        confidence: candidate.confidence,
        x: box.origin.x,
        y: box.origin.y,
        width: box.size.width,
        height: box.size.height
    )
}

func redBadges(in image: CGImage) -> [Badge] {
    let width = image.width
    let height = image.height
    let rowBytes = width * 4
    var pixels = [UInt8](repeating: 0, count: rowBytes * height)
    guard let context = CGContext(data: &pixels, width: width, height: height,
                                  bitsPerComponent: 8, bytesPerRow: rowBytes,
                                  space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return [] }
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    let maxX = min(width, Int(Double(width) * 0.42))
    var active = [Bool](repeating: false, count: width * height)
    for y in 0..<height {
        for x in 0..<maxX {
            let offset = y * rowBytes + x * 4
            let r = Int(pixels[offset])
            let g = Int(pixels[offset + 1])
            let b = Int(pixels[offset + 2])
            active[y * width + x] = r > 205 && g < 150 && b < 150 && r > g + 55 && r > b + 45
        }
    }
    var visited = [Bool](repeating: false, count: width * height)
    var result: [Badge] = []
    for y in 0..<height {
        for x in 0..<maxX {
            let start = y * width + x
            if !active[start] || visited[start] { continue }
            var queue = [start]
            visited[start] = true
            var cursor = 0
            var count = 0
            var minX = x, maxFoundX = x, minY = y, maxY = y
            while cursor < queue.count {
                let index = queue[cursor]
                cursor += 1
                let cx = index % width
                let cy = index / width
                count += 1
                minX = min(minX, cx); maxFoundX = max(maxFoundX, cx)
                minY = min(minY, cy); maxY = max(maxY, cy)
                for (nx, ny) in [(cx - 1, cy), (cx + 1, cy), (cx, cy - 1), (cx, cy + 1)] {
                    guard nx >= 0, nx < maxX, ny >= 0, ny < height else { continue }
                    let next = ny * width + nx
                    if active[next] && !visited[next] { visited[next] = true; queue.append(next) }
                }
            }
            let boxWidth = maxFoundX - minX + 1
            let boxHeight = maxY - minY + 1
            let aspect = Double(boxWidth) / Double(max(1, boxHeight))
            guard count >= 10, boxWidth >= 5, boxHeight >= 5,
                  boxWidth <= 42, boxHeight <= 42, aspect >= 0.45, aspect <= 2.2,
                  Double(minX) / Double(width) >= 0.08,
                  Double(minY) / Double(height) >= 0.08 else { continue }
            result.append(Badge(x: Double(minX) / Double(width),
                                y: 1.0 - Double(maxY + 1) / Double(height),
                                width: Double(boxWidth) / Double(width),
                                height: Double(boxHeight) / Double(height)))
        }
    }
    return result
}

let result = VisionResult(ok: true, imageWidth: image.width, imageHeight: image.height,
                          words: words, redBadges: redBadges(in: image))
FileHandle.standardOutput.write(try! JSONEncoder().encode(result))
