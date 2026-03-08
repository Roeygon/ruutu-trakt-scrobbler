# Ruutu.fi Trakt Scrobbler

Automatically scrobble TV shows and movies you watch on Ruutu.fi to your [Trakt.tv](https://trakt.tv) profile.

## Features

- **Auto-scrobble** — detects what you're watching and reports it to Trakt in real-time
- **Smart tracking** — starts after 2% watched, marks complete at 80%, handles pause/resume
- **Manual check-in** — one-click check-in from the extension popup
- **Now playing** — see what's currently being tracked in the popup
- **Modular architecture** — ready to support additional Finnish streaming services

## Installation

### From Firefox Add-ons (AMO)

1. Visit the extension page on [addons.mozilla.org](#) *(link TBD)*
2. Click **Add to Firefox**
3. Click the extension icon → **Connect to Trakt.tv**
4. Enter the code shown at [trakt.tv/activate](https://trakt.tv/activate)
5. Done! Start watching on Ruutu.fi.

### Manual / Development Install

1. Download or clone this repository
2. Open Firefox → go to `about:debugging#/runtime/this-firefox`
3. Click **Load Temporary Add-on** → select `manifest.json`
4. Click the extension icon → **Connect to Trakt.tv**
5. Enter the code at trakt.tv/activate

> **Note:** Temporary add-ons are removed when Firefox restarts.

## How It Works

When you play a video on `ruutu.fi/video/*`, the extension:

1. Extracts show/movie metadata from the page (JSON-LD structured data, page title, or DOM)
2. Monitors the HTML5 video element for play, pause, and progress events
3. Sends scrobble updates to Trakt.tv every 15 seconds
4. Marks the content as watched when you reach ~80% completion

## Supported Services

| Service | Scrobble | Check-in | Status |
|---------|----------|----------|--------|
| Ruutu.fi | ✅ | ✅ | Active |
| Yle Areena | — | — | Planned |
| Elisa Viihde | — | — | Planned |
| MTV Katsomo | — | — | Planned |

## Adding a New Streaming Service

The extension uses a modular service architecture. All service classes live in `content.js` alongside `BaseService`, `Scrobbler`, and `Overlay`.

### Step-by-step

1. **Add your service class** in `content.js` after `RuutuService`:

```javascript
class YourService extends BaseService {
  static match() {
    return location.hostname === 'www.yoursite.fi' && location.pathname.startsWith('/watch/');
  }

  getMetadata() {
    // Extract show/movie info from the page
    // Return: { type: 'episode', show, season, episode, title }
    // or:     { type: 'movie', title, year }
    // or:     null if not found
  }
}
```

2. **Register** in the `SERVICES` array in `content.js`:

```javascript
var SERVICES = [
  RuutuService,
  YourService, // ← add here
];
```

3. **Add URL pattern** to `manifest.json` in both `permissions` and `content_scripts.matches`:

```json
"permissions": [
  "storage", "tabs",
  "https://api.trakt.tv/*",
  "https://www.ruutu.fi/*",
  "https://www.yoursite.fi/*"
],
"content_scripts": [{
  "matches": [
    "https://www.ruutu.fi/video/*",
    "https://www.yoursite.fi/watch/*"
  ],
  "js": ["content.js"]
}]
```

### Metadata extraction tips

- **JSON-LD** (`<script type="application/ld+json">`) is the most reliable source
- **Page title** patterns are a good fallback
- **DOM scraping** is a last resort (selectors break on site updates)
- Use browser DevTools to inspect the page structure
- Check the Network tab for API calls that return metadata

## Troubleshooting

- **Not detecting video**: Refresh the Ruutu.fi page after installing
- **Check console logs**: Press F12 → Console → filter for `[Scrobbler]`
- **Wrong show matched on Trakt**: This can happen with Finnish titles vs English — check Trakt manually
- **Auth issues**: Click Disconnect in popup, then reconnect

## Privacy

This extension:
- Only activates on supported streaming service pages
- Sends **only** show/movie title, season, episode, and watch progress to Trakt.tv
- Stores only your Trakt authentication token locally in browser storage
- Does not collect, store, or transmit any other personal data
- Contains no analytics, telemetry, or third-party tracking

## Technical Details

- Firefox Manifest V2 (compatible with Firefox 109+)
- Uses Trakt.tv OAuth Device Authentication
- Background script handles all API communication
- Content scripts are isolated per streaming service
- Token auto-refresh before expiration

## License

MIT
