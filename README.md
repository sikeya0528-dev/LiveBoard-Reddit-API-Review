# LiveBoard — Reddit Data API Review Package

## Purpose of this attachment

This ZIP is provided as source-code documentation for a Reddit Data API access request. It contains the Reddit-facing source path used by **LiveBoard**, a personal, non-commercial macOS desktop application.

The package is intentionally scoped to the Reddit integration and the local translation path so that the requested API behavior can be reviewed without unrelated source code, build products, dependencies, test fixtures, or user data.

LiveBoard does **not** contain a Reddit bot account and does not automate posting or other write actions.

## Application purpose

LiveBoard is a local multi-column discussion viewer for macOS. Its Reddit integration is intended only to make public discussion on **r/wallstreetbets** easier to follow for the authenticated user.

For Reddit content, the application:

- reads public posts and comments from `r/wallstreetbets`;
- identifies a currently active discussion thread from public listings;
- displays comments in a local desktop interface;
- periodically checks for new, changed, or deleted comments while the thread is open;
- optionally translates English comment text into Japanese using Apple's on-device Translation framework on the user's Mac.

The Reddit integration is **read-only**.

## Reddit OAuth and permissions

LiveBoard uses the Reddit installed-app OAuth flow.

- OAuth scope: `read` only
- Redirect URI: `http://127.0.0.1:18794/oauth/reddit`
- Authorization flow: browser-based Reddit OAuth with `state` verification
- OAuth duration: permanent, so a refresh token may be issued
- Client type: public / installed client
- Client secret: none is embedded or required by the application

The application will not attempt live Reddit content access unless the user has configured a public client ID and explicitly confirmed that the client ID has received Reddit API approval. This local confirmation is only a safety gate; it does not itself grant or represent Reddit approval.

OAuth access and refresh tokens are handled only in the Electron main process. They are encrypted with Electron `safeStorage` before being written to the app's user-data directory and are not exposed to the renderer process.

## Reddit endpoints used

The implementation is limited to Reddit OAuth endpoints and read endpoints under `https://oauth.reddit.com` for `r/wallstreetbets`.

Current read paths include:

- `/r/wallstreetbets/hot`
- `/r/wallstreetbets/new`
- `/r/wallstreetbets/comments`
- `/comments/{thread_id}`
- `/api/info`

The token endpoint is:

- `https://www.reddit.com/api/v1/access_token`

The application does not implement Reddit write endpoints.

## Polling and rate-limit behavior

The runtime is deliberately bounded.

- active comment polling target: approximately every 5 seconds while an active WSB pane is open;
- candidate-thread refresh target: approximately every 60 seconds;
- initial internal request budget: at most 60 requests per minute;
- Reddit `X-Ratelimit-*` response headers are observed;
- HTTP `429` is treated as a rate-limit condition and triggers backoff;
- HTTP `401`, `403`, network errors, and authentication-expiry states are handled separately;
- polling is stopped when the last WSB pane is closed;
- polling and translation work are paused when the corresponding view is paused/hidden according to the runtime lifecycle.

The source implements a bounded backfill rather than unbounded historical crawling.

## Data handling

Reddit data is used only for the local viewing function described above.

The application does **not**:

- create Reddit posts or comments;
- vote or manipulate karma;
- send private messages or chat messages;
- perform moderation actions;
- scrape Reddit without OAuth as a fallback;
- use a proxy fallback to bypass Reddit access controls;
- sell or redistribute Reddit data;
- use Reddit content for advertising or user profiling;
- use Reddit content to train AI or machine-learning models.

The active WSB stream is bounded in memory. The application also uses `/api/info` checks to detect content-state changes and applies deletion/update state to the live view.

WSB content is excluded from LiveBoard's AI/Markdown export workflow.

## Local Japanese translation

Translation is optional and is performed locally on macOS using Apple's Translation framework.

The relevant Swift source is included under:

- `source/native/wsb-translation-helper/`
- `source/native/wsb-translation-preparer/`

Reddit comment text is not sent by LiveBoard to an external translation service for this feature.

## Why this cannot be implemented as a Devvit app

LiveBoard is a standalone native macOS desktop application rather than an experience that runs inside Reddit.

It combines Reddit public discussions with several independent, non-Reddit discussion sources in a single multi-column desktop UI and integrates with local macOS capabilities, including Apple's on-device Translation framework.

Those desktop-level integrations, local system behavior, and cross-source aggregation are the reason the application is being submitted through the Data API request path instead of being implemented as an in-Reddit Devvit application.

## Source map

Key files included in this review package:

- `source/wsb-reddit-contract.mjs` — approved configuration gate, OAuth authorization URL, callback validation, token exchange, read-request construction.
- `source/wsb-token-store.mjs` — encrypted OAuth token storage using Electron `safeStorage`.
- `source/wsb-runtime-manager.mjs` — loopback OAuth callback server, token refresh, HTTP transport, status/error handling, utility-process management.
- `source/wsb-runtime-worker.mjs` — isolated utility-process worker entry point.
- `source/wsb-runtime-engine.mjs` — polling lifecycle, candidate discovery, comment updates, translation queue coordination.
- `source/wsb-provider-core.mjs` — Reddit read paths, fixed limits, candidate normalization/ranking.
- `source/wsb-provider.mjs` — provider state and bounded acquisition/poll decisions.
- `source/wsb-rate-budget.mjs` — request-budget and Reddit rate-header/backoff logic.
- `source/wsb-flat-stream.mjs` — bounded comment stream, update/deletion reconciliation.
- `source/wsb-subscription-registry.mjs` — generation/lifecycle ownership for live subscriptions.
- `source/wsb-translation-queue.mjs` — bounded local translation queue.
- `source/wsb-pane-lifecycle.mjs` — pane lifecycle, pause/resume/stop behavior.
- `source/wsb-local-runtime.mjs` — local settings/capability state and explicit synthetic sample support.
- `source/electron-main.mjs` — privileged Electron integration and IPC boundary; OAuth tokens remain on the main-process side.
- `source/electron-preload.cjs` — narrow renderer IPC surface for Reddit setup and runtime actions.
- `source/app.js` — renderer-side WSB UI integration; no OAuth token access.
- `source/native/...` — local Apple Translation helper and preparation UI source.
- `source/package.json` / `source/package-lock.json` — dependency and packaging metadata.

## Files intentionally excluded

This review ZIP does not include:

- `node_modules` or downloaded third-party packages;
- the packaged `.app` binary;
- OAuth tokens, cookies, credentials, passwords, or client secrets;
- user settings or personal data;
- test screenshots, large fixtures, logs, or historical implementation reports;
- unrelated discussion-board adapters and most non-Reddit application source.

The complete project source can be provided if Reddit requests additional review material.

## Snapshot

Source snapshot used for this review package:

- LiveBoard build family: `R8-stage07`
- Review source base: `LiveBoard_R8_stage07_macos_verify_hotfix4_source`
- Primary supported subreddit: `r/wallstreetbets`
- Reddit access mode: OAuth, `read` scope only
- Intended use: personal, non-commercial, read-only desktop viewing
