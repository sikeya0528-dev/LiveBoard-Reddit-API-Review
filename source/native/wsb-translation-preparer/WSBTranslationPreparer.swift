#if os(macOS) && canImport(SwiftUI) && canImport(Translation)
import SwiftUI
import Translation
import AppKit
import Combine
#else
import Foundation
#endif

#if os(macOS) && canImport(SwiftUI) && canImport(Translation)
@available(macOS 26.0, *)
@MainActor
final class TranslationPreparationModel: ObservableObject {
    @Published var configuration = TranslationSession.Configuration(
        source: Locale.Language(identifier: "en"),
        target: Locale.Language(identifier: "ja")
    )
    private var requestPreparation = false
    @Published var status = "英語→日本語の言語データを確認します。"
    @Published var busy = false

    func beginPreparation() {
        guard !busy else { return }
        busy = true
        status = "言語データを準備しています…"
        requestPreparation = true

        // Reassign the configuration so ObservableObject publishes the change.
        // This avoids SwiftUI's @State macro, which is not available to the
        // standalone swiftc build used by LiveBoard's native helper packaging.
        var next = configuration
        next.invalidate()
        configuration = next
    }

    func takePreparationRequest() -> Bool {
        guard requestPreparation else { return false }
        requestPreparation = false
        return true
    }

    func finish(ready: Bool) {
        status = ready
            ? "英語→日本語を使用できます。"
            : "準備処理は完了しましたが、言語データをまだ確認できません。"
        print("{\"ok\":\(ready ? "true" : "false"),\"ready\":\(ready ? "true" : "false"),\"reason\":\"\(ready ? "" : "language_assets_not_ready")\"}")
        fflush(stdout)
        busy = false
    }

    func fail() {
        status = "準備できませんでした。システムの案内またはネットワーク状態を確認してください。"
        print("{\"ok\":false,\"ready\":false,\"reason\":\"prepare_translation_failed\"}")
        fflush(stdout)
        busy = false
    }
}

@available(macOS 26.0, *)
struct PrepareTranslationView: View {
    @ObservedObject var model: TranslationPreparationModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("LiveBoard ローカル翻訳").font(.headline)
            Text("Apple Translation の英語→日本語データをこのMacに準備します。翻訳本文はLiveBoard外へ送信しません。")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Text(model.status).font(.callout).textSelection(.enabled)
            HStack {
                Button("英語→日本語を準備") {
                    model.beginPreparation()
                }.disabled(model.busy)
                Spacer()
                Button("閉じる") { NSApplication.shared.terminate(nil) }
            }
        }
        .frame(width: 430)
        .padding(20)
        .translationTask(model.configuration) { session in
            guard await model.takePreparationRequest() else { return }
            do {
                try await session.prepareTranslation()
                let ready = await session.isReady
                await model.finish(ready: ready)
            } catch {
                await model.fail()
            }
        }
    }
}

@main
struct WSBTranslationPreparerApp: App {
    var body: some Scene {
        WindowGroup {
            if #available(macOS 26.0, *) {
                PrepareTranslationView(model: TranslationPreparationModel())
            } else {
                Text("macOS 26以降が必要です").padding(24)
            }
        }
        .windowResizability(.contentSize)
    }
}
#else
@main
struct WSBTranslationPreparerFallback {
    static func main() { print("{\"ok\":false,\"ready\":false,\"reason\":\"apple_translation_framework_unavailable\"}") }
}
#endif
