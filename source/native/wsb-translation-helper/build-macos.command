#!/bin/zsh
set -euo pipefail
cd "${0:A:h}"
mkdir -p build
xcrun --sdk macosx swiftc -O -parse-as-library WSBTranslationHelper.swift -o build/WSBTranslationHelper
printf 'built: %s\n' "$PWD/build/WSBTranslationHelper"
