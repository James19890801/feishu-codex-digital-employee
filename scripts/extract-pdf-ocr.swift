#!/usr/bin/env swift
import AppKit
import Foundation
import PDFKit
import Vision

struct OCRPage: Codable {
    let page: Int
    let text: String
}

struct OCRResult: Codable {
    let pages: [OCRPage]
}

func recognize(_ image: CGImage) throws -> String {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
    return (request.results ?? [])
        .compactMap { $0.topCandidates(1).first?.string }
        .joined(separator: "\n")
}

guard CommandLine.arguments.count == 2 else {
    fputs("usage: extract-pdf-ocr.swift FILE\n", stderr)
    exit(2)
}

let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let document = PDFDocument(url: url) else {
    fputs("unable to open PDF\n", stderr)
    exit(1)
}

var pages: [OCRPage] = []
for index in 0..<min(document.pageCount, 20) {
    guard let page = document.page(at: index) else { continue }
    let bounds = page.bounds(for: .mediaBox)
    let scale: CGFloat = 2.0
    let width = max(1, Int(bounds.width * scale))
    let height = max(1, Int(bounds.height * scale))
    guard let context = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { continue }
    context.setFillColor(NSColor.white.cgColor)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.saveGState()
    context.scaleBy(x: scale, y: scale)
    page.draw(with: .mediaBox, to: context)
    context.restoreGState()
    guard let image = context.makeImage() else { continue }
    let text = (try? recognize(image))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if !text.isEmpty {
        pages.append(OCRPage(page: index + 1, text: text))
    }
}

let data = try JSONEncoder().encode(OCRResult(pages: pages))
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write(Data("\n".utf8))
