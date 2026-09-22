# WSB Translation helper prototype

JSON Lines protocol only. It accepts at most 8 English comments / 4,000 characters per batch and returns the same `batchId` / `commentId` values with Japanese translations. Comment text is not written to stderr or diagnostic logs.

The macOS implementation uses `TranslationSession(installedSource:target:)`, so it is intentionally offline-only and does not attempt a model download. If English/Japanese language assets are not already installed, translation fails instead of silently using a network service. Model preparation/consent must happen in a user-visible macOS native flow before this helper is started.

Build on the target Mac with `./build-macos.command`. This Linux review environment can only compile and exercise the non-Translation fallback branch.

`measure-macos.command` runs the fixed 60-sentence corpus three times and saves elapsed-time, `/usr/bin/time -l` resource output, translations, and automatic preservation reports. Network disconnection is intentionally a manual prerequisite so the script cannot silently alter the user's network configuration.
