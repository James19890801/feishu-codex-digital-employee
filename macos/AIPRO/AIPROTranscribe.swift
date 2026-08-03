import AVFoundation
import Foundation
import Speech

enum TranscriptionFailure: LocalizedError {
    case usage
    case unavailable
    case unsupportedLocale(String)
    case emptyTranscript

    var errorDescription: String? {
        switch self {
        case .usage:
            return "usage: AIPROTranscribe <audio-file> [locale]"
        case .unavailable:
            return "Apple on-device speech transcription is unavailable"
        case .unsupportedLocale(let locale):
            return "Speech transcription locale is unsupported: \(locale)"
        case .emptyTranscript:
            return "Speech transcription returned no text"
        }
    }
}

@available(macOS 26.0, *)
private func transcribe(fileURL: URL, requestedLocale: Locale) async throws -> String {
    guard SpeechTranscriber.isAvailable else { throw TranscriptionFailure.unavailable }
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: requestedLocale) else {
        throw TranscriptionFailure.unsupportedLocale(requestedLocale.identifier)
    }

    let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
    if let installation = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
        try await installation.downloadAndInstall()
    }
    _ = try await AssetInventory.reserve(locale: locale)

    let audioFile = try AVAudioFile(forReading: fileURL)
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    let collector = Task<String, Error> {
        var parts: [String] = []
        for try await result in transcriber.results where result.isFinal {
            let value = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
            if !value.isEmpty { parts.append(value) }
        }
        return parts.joined(separator: "\n")
    }

    do {
        try await analyzer.start(inputAudioFile: audioFile, finishAfterFile: true)
        let transcript = try await collector.value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !transcript.isEmpty else { throw TranscriptionFailure.emptyTranscript }
        return transcript
    } catch {
        collector.cancel()
        throw error
    }
}

@main
struct AIPROTranscribe {
    static func main() async {
        do {
            guard CommandLine.arguments.count >= 2 else { throw TranscriptionFailure.usage }
            guard #available(macOS 26.0, *) else { throw TranscriptionFailure.unavailable }
            let fileURL = URL(fileURLWithPath: CommandLine.arguments[1]).standardizedFileURL
            let locale = Locale(identifier: CommandLine.arguments.count >= 3
                ? CommandLine.arguments[2]
                : "zh-CN")
            let transcript = try await transcribe(fileURL: fileURL, requestedLocale: locale)
            FileHandle.standardOutput.write(Data((transcript + "\n").utf8))
        } catch {
            let message = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
            FileHandle.standardError.write(Data((message + "\n").utf8))
            Foundation.exit(1)
        }
    }
}
