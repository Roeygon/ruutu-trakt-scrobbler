# AGENTS.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Project type and current tooling
- Firefox WebExtension (Manifest V2), currently focused on `https://www.ruutu.fi/video/*`.
- Plain JavaScript/HTML extension sources; no Node/Python/Rust/Go toolchain files are present.
- No repository-defined lint or automated test commands currently exist.

## Common development workflow
### Run locally in Firefox (development)
1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on** and select `manifest.json`.
3. Open a Ruutu video page and use browser DevTools Console (filter logs by `[Scrobbler]`).
4. Use the extension popup to connect to Trakt via device auth.

### Validate extension wiring after changes
- Confirm `manifest.json` keeps host permission `https://www.ruutu.fi/*` in `permissions`.
- Confirm `content_scripts.matches` still includes `https://www.ruutu.fi/video/*`.
- Reload the temporary add-on after editing scripts.

## High-level architecture
### Runtime split
- `manifest.json` wires:
  - background scripts: `config.js` + `background.js`
  - content script: `content.js` on Ruutu video URLs
  - popup UI: `popup.html` + `popup.js`

### Core data flow
1. `content.js` detects service (`RuutuService`) and extracts metadata from page JSON-LD (fallback: page title).
2. `Scrobbler` attaches to `<video>`, tracks play/pause/progress thresholds, and sends runtime messages.
3. `background.js` handles all Trakt API operations (auth, token refresh, scrobble/checkin, show resolution, corrections).
4. Responses are returned to content/popup; content overlay and popup state are updated accordingly.

### Key modules
- `content.js`
  - `BaseService` contract for streaming services.
  - `RuutuService` implementation for metadata extraction.
  - `Scrobbler` state machine (`idle`/`playing`/`paused`/`stopped`) and interval-based updates.
  - `Overlay` for on-page status, not-found feedback, and correction entry point.
  - SPA navigation handling via `MutationObserver` to reinitialize on URL changes.
- `background.js`
  - OAuth Device Auth lifecycle (`DEVICE_AUTH_START`, `DEVICE_AUTH_POLL`, `DEVICE_AUTH_CANCEL`).
  - Token storage/refresh in extension local storage.
  - Trakt calls (`scrobble`, `checkin`, search/show resolution).
  - Correction persistence and in-memory show ID cache.
  - Global now-playing state exposed to popup.
- `popup.js` / `popup.html`
  - Connection/auth UX.
  - “Now Playing” display + manual check-in.
  - Correction management (save/delete mapping from source title to Trakt show).

## Message contracts to preserve
- From content to background: `STATUS`, `SCROBBLE`, `OPEN_TRAKT_SEARCH`.
- From popup to background: `GET_STATUS`, `CHECKIN`, `LOGOUT`, `RESOLVE_URL`, `GET_CORRECTIONS`, `REMOVE_CORRECTION`, device auth messages.
- From popup/background to content: `CORRECTION_APPLIED`.

Breaking these message types or payload fields will break cross-context behavior.

## Repository-specific constraints
- `config.js` is loaded before `background.js` and must define `CONFIG.TRAKT_CLIENT_ID` and `CONFIG.TRAKT_CLIENT_SECRET`.
- Keep `config.example.js` aligned with required `CONFIG` keys when changing auth config shape.
- Important manifest invariant: host permission for Ruutu must remain in `permissions` (not only in `content_scripts.matches`) or content script injection fails on Firefox.
