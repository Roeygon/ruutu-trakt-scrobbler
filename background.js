// Background Script -- Trakt API Integration
// Handles: device authentication, scrobbling, checkin, token refresh,
// show search/matching, corrections.
// CONFIG is loaded from config.js (included before this in manifest).

var api = typeof browser !== 'undefined' ? browser : chrome;
var TRAKT = 'https://api.trakt.tv';

// =====================================================================
// Token Storage
// =====================================================================

async function getTokens() {
  return api.storage.local.get([
    'trakt_access_token', 'trakt_refresh_token', 'trakt_expires_at',
  ]);
}

async function saveTokens(data) {
  await api.storage.local.set({
    trakt_access_token: data.access_token,
    trakt_refresh_token: data.refresh_token,
    trakt_expires_at: Date.now() + (data.expires_in * 1000),
  });
}

async function clearTokens() {
  await api.storage.local.remove([
    'trakt_access_token', 'trakt_refresh_token', 'trakt_expires_at',
  ]);
}

async function getAccessToken() {
  var t = await getTokens();
  if (!t.trakt_access_token) return null;
  if (t.trakt_expires_at && Date.now() > t.trakt_expires_at - 300000) {
    return await refreshAccessToken(t.trakt_refresh_token);
  }
  return t.trakt_access_token;
}

async function refreshAccessToken(refreshToken) {
  try {
    var res = await fetch(TRAKT + '/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        refresh_token: refreshToken,
        client_id: CONFIG.TRAKT_CLIENT_ID,
        client_secret: CONFIG.TRAKT_CLIENT_SECRET,
        grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) return null;
    var data = await res.json();
    await saveTokens(data);
    return data.access_token;
  } catch (e) {
    console.error('[Background] Token refresh failed:', e);
    return null;
  }
}

// =====================================================================
// Device Authentication
// =====================================================================

var pollTimer = null;

async function deviceAuthStart() {
  try {
    var res = await fetch(TRAKT + '/oauth/device/code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: CONFIG.TRAKT_CLIENT_ID }),
    });
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
    var d = await res.json();
    return {
      ok: true,
      user_code: d.user_code,
      verification_url: d.verification_url,
      device_code: d.device_code,
      interval: d.interval,
      expires_in: d.expires_in,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function deviceAuthPoll(deviceCode, interval) {
  return new Promise(function(resolve) {
    var attempts = 0;

    var poll = async function() {
      attempts++;
      if (attempts > 120) {
        resolve({ ok: false, error: 'Timed out. Please try again.' });
        return;
      }
      try {
        var res = await fetch(TRAKT + '/oauth/device/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: deviceCode,
            client_id: CONFIG.TRAKT_CLIENT_ID,
            client_secret: CONFIG.TRAKT_CLIENT_SECRET,
          }),
        });
        if (res.status === 200) {
          var data = await res.json();
          await saveTokens(data);
          resolve({ ok: true });
          return;
        }
        if (res.status === 400) { pollTimer = setTimeout(poll, interval * 1000); return; }
        if (res.status === 410) { resolve({ ok: false, error: 'Code expired. Try again.' }); return; }
        if (res.status === 418) { resolve({ ok: false, error: 'Authorization denied.' }); return; }
        if (res.status === 429) { pollTimer = setTimeout(poll, interval * 2000); return; }
        resolve({ ok: false, error: 'Unexpected response: ' + res.status });
      } catch (e) {
        pollTimer = setTimeout(poll, interval * 1000);
      }
    };

    pollTimer = setTimeout(poll, interval * 1000);
  });
}

function deviceAuthCancel() {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
}

// =====================================================================
// Trakt API Calls
// =====================================================================

async function traktHeaders() {
  var token = await getAccessToken();
  if (!token) return null;
  return {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + token,
    'trakt-api-version': '2',
    'trakt-api-key': CONFIG.TRAKT_CLIENT_ID,
  };
}

async function traktGet(path, params) {
  var headers = await traktHeaders();
  if (!headers) return null;
  var url = new URL(TRAKT + path);
  if (params) {
    var keys = Object.keys(params);
    for (var i = 0; i < keys.length; i++) {
      if (params[keys[i]] != null) url.searchParams.set(keys[i], params[keys[i]]);
    }
  }
  try {
    var res = await fetch(url.toString(), { headers: headers });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.error('[BG] GET failed:', path, e);
    return null;
  }
}

// =====================================================================
// Correction Cache (persistent)
// =====================================================================

async function getCorrections() {
  var data = await api.storage.local.get('corrections');
  return data.corrections || {};
}

async function saveCorrection(sourceTitle, traktInfo) {
  var corrections = await getCorrections();
  corrections[sourceTitle.toLowerCase()] = traktInfo;
  await api.storage.local.set({ corrections: corrections });
}

async function removeCorrection(sourceTitle) {
  var corrections = await getCorrections();
  delete corrections[sourceTitle.toLowerCase()];
  await api.storage.local.set({ corrections: corrections });
}

// =====================================================================
// Show Search and Matching
// =====================================================================

var showIdCache = {};

async function resolveShowId(metadata) {
  if (metadata.type !== 'episode' || !metadata.show) return null;
  var key = metadata.show.toLowerCase();

  // 1. In-memory cache
  if (showIdCache[key]) return showIdCache[key];

  // 2. Persistent corrections
  var corrections = await getCorrections();
  if (corrections[key]) {
    showIdCache[key] = corrections[key];
    return corrections[key];
  }

  // 3. Search Trakt
  var results = await traktGet('/search/show', { query: metadata.show, field: 'title', limit: '10' });
  if (!results || results.length === 0) return null;

  // 4. Single result - use it
  if (results.length === 1) {
    var info = extractShowInfo(results[0].show);
    showIdCache[key] = info;
    return info;
  }

  // 5. Multiple results - match by episode title
  if (metadata.title && metadata.season && metadata.episode) {
    for (var i = 0; i < results.length; i++) {
      var epData = await traktGet(
        '/shows/' + results[i].show.ids.trakt + '/seasons/' + metadata.season + '/episodes/' + metadata.episode
      );
      if (epData && epData.title) {
        var traktEp = epData.title.toLowerCase().trim();
        var sourceEp = metadata.title.toLowerCase().trim();
        if (traktEp === sourceEp || traktEp.indexOf(sourceEp) >= 0 || sourceEp.indexOf(traktEp) >= 0) {
          var matched = extractShowInfo(results[i].show);
          showIdCache[key] = matched;
          console.log('[BG] Matched by episode title:', matched.trakt_title);
          return matched;
        }
      }
    }
  }

  // 6. Fallback: first result, flagged uncertain
  var fallback = extractShowInfo(results[0].show);
  fallback.uncertain = true;
  showIdCache[key] = fallback;
  return fallback;
}

function extractShowInfo(show) {
  return {
    trakt_id: show.ids.trakt,
    trakt_slug: show.ids.slug,
    trakt_title: show.title,
    trakt_year: show.year,
  };
}

async function resolveFromUrl(url) {
  var m = url.match(/trakt\.tv\/shows\/([a-z0-9-]+)/i);
  if (!m) return { ok: false, error: 'Invalid URL. Use: https://trakt.tv/shows/show-name' };
  var show = await traktGet('/shows/' + m[1], { extended: 'full' });
  if (!show) return { ok: false, error: 'Show "' + m[1] + '" not found on Trakt.' };
  return { ok: true, info: extractShowInfo(show) };
}

// =====================================================================
// Payload Builder (with Trakt ID support)
// =====================================================================

function buildPayload(metadata, showInfo) {
  var body = {};
  if (metadata.type === 'episode') {
    if (showInfo && showInfo.trakt_id) {
      body.show = { ids: { trakt: showInfo.trakt_id } };
    } else {
      body.show = { title: metadata.show };
    }
    body.episode = { season: metadata.season, number: metadata.episode };
    if (metadata.title) body.episode.title = metadata.title;
  } else if (metadata.type === 'movie') {
    body.movie = { title: metadata.title };
    if (metadata.year) body.movie.year = metadata.year;
  }
  return body;
}

// -- Scrobble -------------------------------------------------------

async function scrobble(action, metadata, progress) {
  var headers = await traktHeaders();
  if (!headers) return { ok: false, error: 'Not authenticated' };

  var showInfo = null;
  if (metadata.type === 'episode') {
    showInfo = await resolveShowId(metadata);
    if (!showInfo) {
      return { ok: false, error: 'not_found', showTitle: metadata.show };
    }
  }

  var body = buildPayload(metadata, showInfo);
  body.progress = progress;

  try {
    var res = await fetch(TRAKT + '/scrobble/' + action, {
      method: 'POST', headers: headers, body: JSON.stringify(body),
    });
    if (res.status === 409) return { ok: true, note: 'Already scrobbled', showInfo: showInfo };
    if (res.status === 404) return { ok: false, error: 'not_found', showTitle: metadata.show };
    if (!res.ok) return { ok: false, error: res.status + ': ' + (await res.text()) };
    var data = await res.json();
    console.log('[Background] Scrobble ' + action + ':', data);
    return { ok: true, data: data, showInfo: showInfo };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// -- Checkin --------------------------------------------------------

async function checkin(metadata) {
  var headers = await traktHeaders();
  if (!headers) return { ok: false, error: 'Not authenticated' };

  var showInfo = null;
  if (metadata.type === 'episode') {
    showInfo = await resolveShowId(metadata);
    if (!showInfo) return { ok: false, error: 'Show "' + metadata.show + '" not found on Trakt.' };
  }

  try {
    var res = await fetch(TRAKT + '/checkin', {
      method: 'POST', headers: headers, body: JSON.stringify(buildPayload(metadata, showInfo)),
    });
    if (res.status === 409) {
      return { ok: false, error: 'Already checked in. Cancel current checkin on Trakt first.' };
    }
    if (!res.ok) return { ok: false, error: await res.text() };
    return { ok: true, data: await res.json() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// =====================================================================
// Now Playing State
// =====================================================================

var nowPlaying = null;
var nowPlayingInfo = null;
var nowPlayingTabId = null;

// =====================================================================
// Message Router
// =====================================================================

api.runtime.onMessage.addListener(function(msg, sender, respond) {
  switch (msg.type) {
    case 'SCROBBLE':
      nowPlaying = msg.metadata;
      scrobble(msg.action, msg.metadata, msg.progress).then(function(r) {
        if (r.showInfo) nowPlayingInfo = r.showInfo;
        respond(r);
      });
      return true;

    case 'CHECKIN':
      checkin(msg.metadata).then(respond);
      return true;

    case 'STATUS':
      if (msg.status === 'detected') {
        nowPlaying = msg.metadata;
        nowPlayingInfo = null; // clear stale info until next successful scrobble
        nowPlayingTabId = sender.tab ? sender.tab.id : null;
        api.browserAction.setBadgeText({ text: '\u25b6' });
        api.browserAction.setBadgeBackgroundColor({ color: '#ED1C24' });
      }
      return false;

    case 'DEVICE_AUTH_START':
      deviceAuthStart().then(respond);
      return true;

    case 'DEVICE_AUTH_POLL':
      deviceAuthPoll(msg.deviceCode, msg.interval).then(respond);
      return true;

    case 'DEVICE_AUTH_CANCEL':
      deviceAuthCancel();
      respond({ ok: true });
      return false;

    case 'GET_STATUS':
      getTokens().then(function(t) {
        respond({
          authenticated: !!t.trakt_access_token,
          nowPlaying: nowPlaying,
          nowPlayingInfo: nowPlayingInfo,
        });
      });
      return true;

    case 'LOGOUT':
      nowPlaying = null;
      nowPlayingInfo = null;
      clearTokens().then(function() {
        api.browserAction.setBadgeText({ text: '' });
        respond({ ok: true });
      });
      return true;

    case 'RESOLVE_URL':
      resolveFromUrl(msg.url).then(function(result) {
        if (result.ok && msg.sourceTitle) {
          saveCorrection(msg.sourceTitle, result.info).then(function() {
            delete showIdCache[msg.sourceTitle.toLowerCase()];
            nowPlayingInfo = result.info;
            respond(result);
          });
        } else {
          respond(result);
        }
      });
      return true;

    case 'GET_CORRECTIONS':
      getCorrections().then(respond);
      return true;

    case 'REMOVE_CORRECTION':
      removeCorrection(msg.sourceTitle).then(function() {
        delete showIdCache[msg.sourceTitle.toLowerCase()];
        respond({ ok: true });
      });
      return true;

    case 'GET_HISTORY':
      traktGet('/users/me/history', { limit: msg.limit || 5 }).then(function(data) {
        respond({ ok: !!data, history: data || [] });
      });
      return true;

    case 'OPEN_TRAKT_SEARCH':
      api.tabs.create({ url: 'https://trakt.tv/search?query=' + encodeURIComponent(msg.query || '') });
      respond({ ok: true });
      return false;

    default:
      return false;
  }
});

api.tabs.onRemoved.addListener(function(tabId) {
  if (tabId === nowPlayingTabId) {
    nowPlaying = null;
    nowPlayingInfo = null;
    nowPlayingTabId = null;
    api.browserAction.setBadgeText({ text: '' });
  }
});
