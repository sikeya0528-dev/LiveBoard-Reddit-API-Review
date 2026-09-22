#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/native-bin"
mkdir -p "$OUT"
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "WSB native build requires macOS" >&2
  exit 2
fi
SDK="$(xcrun --sdk macosx --show-sdk-path)"
TARGET="arm64-apple-macos15.0"
xcrun --sdk macosx swiftc -O -parse-as-library -target "$TARGET" -sdk "$SDK" "$ROOT/native/wsb-translation-helper/WSBTranslationHelper.swift" -o "$OUT/WSBTranslationHelper"
xcrun --sdk macosx swiftc -O -parse-as-library -target "$TARGET" -sdk "$SDK" "$ROOT/native/wsb-translation-preparer/WSBTranslationPreparer.swift" -o "$OUT/WSBTranslationPreparer"
chmod 755 "$OUT/WSBTranslationHelper" "$OUT/WSBTranslationPreparer"
HELPER_HASH="$(shasum -a 256 "$OUT/WSBTranslationHelper" | awk '{print $1}')"
PREPARER_HASH="$(shasum -a 256 "$OUT/WSBTranslationPreparer" | awk '{print $1}')"
cat > "$OUT/manifest.json" <<JSON
{"arch":"arm64","minimumMacOS":"15.0","helperSha256":"$HELPER_HASH","preparerSha256":"$PREPARER_HASH"}
JSON
printf 'built helper: %s\nbuilt preparer: %s\n' "$OUT/WSBTranslationHelper" "$OUT/WSBTranslationPreparer"
