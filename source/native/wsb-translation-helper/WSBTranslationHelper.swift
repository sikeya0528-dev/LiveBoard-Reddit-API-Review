import Foundation
#if os(macOS) && canImport(Translation)
import Translation
#endif

struct HelperItem: Codable, Sendable {
    let commentId: String
    let text: String
}
struct HelperRequest: Codable, Sendable {
    let type: String
    let batchId: String?
    let source: String?
    let target: String?
    let items: [HelperItem]?
}
struct HelperResultItem: Codable, Sendable {
    let commentId: String
    let translatedText: String?
    let error: String?
}
struct HelperResponse: Codable, Sendable {
    let type: String
    let batchId: String?
    let ok: Bool
    let engine: String
    let offlineReady: Bool
    let results: [HelperResultItem]?
    let error: String?
}

enum HelperFailure: Error {
    case invalidRequest(String)
}

@main
struct WSBTranslationHelper {
    static let encoder = JSONEncoder()
    static let decoder = JSONDecoder()

    static func write(_ value: HelperResponse) {
        guard let data = try? encoder.encode(value), let line = String(data: data, encoding: .utf8) else { return }
        FileHandle.standardOutput.write(Data((line + "\n").utf8))
    }

    static func validate(_ request: HelperRequest) throws -> [HelperItem] {
        guard request.type == "translate" else { throw HelperFailure.invalidRequest("unsupported_type") }
        guard request.source == "en", request.target == "ja" else { throw HelperFailure.invalidRequest("unsupported_language_pair") }
        let items = request.items ?? []
        guard !items.isEmpty, items.count <= 8 else { throw HelperFailure.invalidRequest("batch_item_limit") }
        let totalChars = items.reduce(0) { $0 + $1.text.count }
        guard totalChars <= 4000 else { throw HelperFailure.invalidRequest("batch_character_limit") }
        var ids = Set<String>()
        for item in items {
            guard !item.commentId.isEmpty, item.commentId.count <= 128, !item.text.isEmpty else { throw HelperFailure.invalidRequest("item_invalid") }
            guard ids.insert(item.commentId).inserted else { throw HelperFailure.invalidRequest("duplicate_comment_id") }
        }
        return items
    }

    static func capabilityResponse() async -> HelperResponse {
        #if os(macOS) && canImport(Translation)
        if #available(macOS 26.0, *) {
            let source = Locale.Language(identifier: "en")
            let target = Locale.Language(identifier: "ja")
            let session = TranslationSession(installedSource: source, target: target)
            let ready = await session.isReady
            return HelperResponse(type: "capabilities", batchId: nil, ok: true, engine: "apple-translation", offlineReady: ready, results: nil, error: ready ? nil : "language_assets_not_ready")
        }
        return HelperResponse(type: "capabilities", batchId: nil, ok: false, engine: "apple-translation", offlineReady: false, results: nil, error: "macos_26_or_later_required_for_headless_helper")
        #else
        return HelperResponse(type: "capabilities", batchId: nil, ok: false, engine: "unavailable", offlineReady: false, results: nil, error: "apple_translation_framework_unavailable")
        #endif
    }

    #if os(macOS) && canImport(Translation)
    @available(macOS 26.0, *)
    static func translateOnMac(_ request: HelperRequest, items: [HelperItem]) async -> HelperResponse {
        let source = Locale.Language(identifier: "en")
        let target = Locale.Language(identifier: "ja")
        let session = TranslationSession(installedSource: source, target: target)
        let batch = items.map { TranslationSession.Request(sourceText: $0.text, clientIdentifier: $0.commentId) }
        do {
            let responses = try await session.translations(from: batch)
            // Swift 6.2 can fail to infer Dictionary<Key, Value> through
            // compactMap over TranslationSession.Response. Build the mapping
            // explicitly so the Apple Translation response types remain fully
            // concrete on the macOS toolchain.
            var byId: [String: String] = [:]
            byId.reserveCapacity(responses.count)
            for response in responses {
                guard let id = response.clientIdentifier else { continue }
                byId[id] = response.targetText
            }
            let result = items.map { item in
                if let translated = byId[item.commentId] {
                    return HelperResultItem(commentId: item.commentId, translatedText: translated, error: nil)
                }
                return HelperResultItem(commentId: item.commentId, translatedText: nil, error: "missing_translation_response")
            }
            return HelperResponse(type: "translation", batchId: request.batchId, ok: result.allSatisfy { $0.error == nil }, engine: "apple-translation", offlineReady: true, results: result, error: nil)
        } catch {
            return HelperResponse(type: "translation", batchId: request.batchId, ok: false, engine: "apple-translation", offlineReady: false, results: nil, error: "translation_failed:\(String(describing: type(of: error)))")
        }
    }
    #endif

    static func handle(_ request: HelperRequest) async -> HelperResponse {
        if request.type == "capabilities" { return await capabilityResponse() }
        do {
            let items = try validate(request)
            #if os(macOS) && canImport(Translation)
            if #available(macOS 26.0, *) { return await translateOnMac(request, items: items) }
            #endif
            return HelperResponse(type: "translation", batchId: request.batchId, ok: false, engine: "unavailable", offlineReady: false, results: items.map { HelperResultItem(commentId: $0.commentId, translatedText: nil, error: "apple_translation_framework_unavailable") }, error: "apple_translation_framework_unavailable")
        } catch HelperFailure.invalidRequest(let reason) {
            return HelperResponse(type: "translation", batchId: request.batchId, ok: false, engine: "validation", offlineReady: false, results: nil, error: reason)
        } catch {
            return HelperResponse(type: "translation", batchId: request.batchId, ok: false, engine: "validation", offlineReady: false, results: nil, error: "invalid_request")
        }
    }

    static func main() async {
        while let line = readLine() {
            guard let data = line.data(using: .utf8), let request = try? decoder.decode(HelperRequest.self, from: data) else {
                write(HelperResponse(type: "error", batchId: nil, ok: false, engine: "validation", offlineReady: false, results: nil, error: "invalid_json"))
                continue
            }
            write(await handle(request))
        }
    }
}
