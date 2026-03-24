// Ruutu.fi Trakt Scrobbler -- Content Script
// Combined: BaseService + RuutuService + Scrobbler + Overlay + Entry Point
// Runs on https://www.ruutu.fi/video/*

(function () {
  'use strict';

  var api = typeof browser !== 'undefined' ? browser : chrome;

  // =====================================================================
  // BASE SERVICE -- Interface for streaming services
  // =====================================================================

  class BaseService {
    static match() { return false; }
    init() {}
    getVideoElement() { return document.querySelector('video'); }
    getMetadata() { return null; }
    _parseDuration(str) {
      if (!str) return 0;
      var m = str.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
      if (!m) return 0;
      return ((parseInt(m[1]) || 0) * 3600) + ((parseInt(m[2]) || 0) * 60) + (parseInt(m[3]) || 0);
    }
  }

  // =====================================================================
  // RUUTU SERVICE -- Metadata extraction for Ruutu.fi
  // =====================================================================

  class RuutuService extends BaseService {
    static match() {
      return location.hostname === 'www.ruutu.fi' && location.pathname.startsWith('/video/');
    }

    getMetadata() {
      var scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (var i = 0; i < scripts.length; i++) {
        try {
          var data = JSON.parse(scripts[i].textContent);
          if (data['@type'] === 'TVEpisode') {
            return {
              type: 'episode',
              show: data.partOfSeries && data.partOfSeries.name,
              season: data.partOfSeason && data.partOfSeason.seasonNumber,
              episode: data.episodeNumber,
              title: data.name,
              duration: this._parseDuration(data.video && data.video.duration),
            };
          }
          if (data['@type'] === 'Movie' || data['@type'] === 'VideoObject') {
            return {
              type: 'movie',
              title: data.name,
              year: data.datePublished ? new Date(data.datePublished).getFullYear() : null,
              duration: this._parseDuration((data.video && data.video.duration) || data.duration),
            };
          }
        } catch (e) { /* ignore parse errors */ }
      }
      return this._fromPageTitle();
    }

    _fromPageTitle() {
      var title = document.title.replace(/\s*[-|].*$/, '').trim();
      if (!title) return null;
      return { type: 'movie', title: title };
    }
  }

  // =====================================================================
  // YLE AREENA SERVICE
  // =====================================================================

  class YleAreenaService extends BaseService {
    static match() {
      return location.hostname === 'areena.yle.fi' && /^\/1-\d+/.test(location.pathname);
    }

    getMetadata() {
      var scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (var i = 0; i < scripts.length; i++) {
        try {
          var data = JSON.parse(scripts[i].textContent);
          // Handle both direct object and @graph array
          var items = data['@graph'] ? data['@graph'] : [data];
          for (var j = 0; j < items.length; j++) {
            var item = items[j];
            if (item['@type'] === 'TVEpisode') {
              var showName = item.partOfSeries && item.partOfSeries.name;
              var season = item.partOfSeason && item.partOfSeason.seasonNumber;
              var rawName = item.name || '';
              var episodeNum = null;
              var title = rawName;

              // Yle names are like "Season 1, 1/8 New Neighbour" — extract episode number and title
              var epMatch = rawName.match(/(?:Season\s+\d+,\s+)?(\d+)\/\d+\s*(.*)/i);
              if (epMatch) {
                episodeNum = parseInt(epMatch[1]);
                title = epMatch[2].trim() || rawName;
              }

              return {
                type: 'episode',
                show: showName,
                season: season,
                episode: episodeNum,
                title: title,
                duration: this._parseDuration(item.duration || (item.video && item.video.duration)),
              };
            }
            if (item['@type'] === 'Movie' || item['@type'] === 'VideoObject') {
              return {
                type: 'movie',
                title: item.name,
                year: item.dateCreated ? parseInt(item.dateCreated) : null,
                duration: this._parseDuration(item.duration || (item.video && item.video.duration)),
              };
            }
          }
        } catch (e) { /* ignore parse errors */ }
      }
      return this._fromMeta();
    }

    _fromMeta() {
      var ogTitle = document.querySelector('meta[property="og:title"]');
      if (!ogTitle || !ogTitle.content) return null;
      // Format: "Episode Title | Show Name"
      var parts = ogTitle.content.split('|');
      if (parts.length >= 2) {
        return { type: 'episode', show: parts[1].trim(), title: parts[0].trim() };
      }
      return { type: 'movie', title: ogTitle.content.trim() };
    }
  }

  // =====================================================================
  // MTV KATSOMO SERVICE
  // =====================================================================

  class MtvKatsomoService extends BaseService {
    static match() {
      return location.hostname === 'www.mtv.fi' && location.pathname.startsWith('/video/');
    }

    getMetadata() {
      var ogTitle = document.querySelector('meta[property="og:title"]');
      var ogDesc  = document.querySelector('meta[property="og:description"]');
      var rawTitle = (ogTitle && ogTitle.content) || document.title || '';
      var desc     = (ogDesc  && ogDesc.content)  || '';

      // Strip trailing site suffix
      var cleanTitle = rawTitle.replace(/\s*-\s*Katso\s+MTV\s+Katsomossa\s*$/i, '').trim();

      var seasonNum  = null;
      var episodeNum = null;

      // Description often starts with "Kausi X, Y/Z." — most reliable source
      var dKausi = desc.match(/Kausi\s+(\d+)/i);
      var dJakso = desc.match(/Jakso\s+(\d+)/i);
      var dPos   = desc.match(/(\d+)\/\d+/);
      if (dKausi) seasonNum  = parseInt(dKausi[1]);
      if (dJakso) episodeNum = parseInt(dJakso[1]);
      else if (dPos) episodeNum = parseInt(dPos[1]);

      // Also try title: "Show Name - Jakso X, Kausi Y"
      var tKausi = cleanTitle.match(/Kausi\s+(\d+)/i);
      var tJakso = cleanTitle.match(/Jakso\s+(\d+)/i);
      if (!seasonNum  && tKausi) seasonNum  = parseInt(tKausi[1]);
      if (!episodeNum && tJakso) episodeNum = parseInt(tJakso[1]);

      // Extract show name — everything before the first " - Jakso/Kausi" segment
      var showName = null;
      var epTitle  = null;
      var tJaksoMatch = cleanTitle.match(/^(.+?)\s*-\s*(?:Jakso|Kausi)\s+\d+/i);
      if (tJaksoMatch) {
        showName = tJaksoMatch[1].trim();
      } else {
        var parts = cleanTitle.split(/\s*-\s*/);
        showName = parts[0].trim();
        if (parts.length >= 3 && !parts[1].match(/Kausi|Jakso/i)) {
          epTitle = parts[1].trim();
        }
      }

      if (!showName) return null;

      if (seasonNum || episodeNum) {
        return {
          type: 'episode',
          show: showName,
          season: seasonNum,
          episode: episodeNum,
          title: epTitle,
          duration: 0,
        };
      }
      return { type: 'movie', title: showName };
    }
  }

  // =====================================================================
  // OVERLAY -- On-page scrobble status display
  // =====================================================================

  class Overlay {
    constructor() {
      this.el = null;
      this.hideTimer = null;
      this.onWrongShow = null;
    }

    _create() {
      if (this.el) return;
      this.el = document.createElement('div');
      this.el.id = 'trakt-scrobbler-overlay';
      this.el.style.cssText =
        'position:fixed;top:14px;right:14px;z-index:999999;' +
        'background:rgba(22,22,42,0.92);color:#e0e0e0;' +
        'padding:8px 14px;border-radius:8px;' +
        'font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
        'box-shadow:0 4px 16px rgba(0,0,0,0.4);' +
        'border-left:3px solid #ed1c24;' +
        'transition:opacity 0.4s,transform 0.4s;' +
        'opacity:0;transform:translateY(-8px);max-width:340px;';
      (document.fullscreenElement || document.body).appendChild(this.el);

      var self = this;
      document.addEventListener('fullscreenchange', function() {
        if (!self.el) return;
        if (document.fullscreenElement) {
          document.fullscreenElement.appendChild(self.el);
        } else {
          document.body.appendChild(self.el);
        }
      });
    }

    _showNode(node, autoHide, noPointerEvents) {
      this._create();
      this.el.textContent = '';
      this.el.appendChild(node);
      this.el.style.pointerEvents = noPointerEvents ? 'none' : 'auto';
      var self = this;
      requestAnimationFrame(function() {
        self.el.style.opacity = '1';
        self.el.style.transform = 'translateY(0)';
      });
      clearTimeout(this.hideTimer);
      if (autoHide > 0) {
        this.hideTimer = setTimeout(function() { self.hide(); }, autoHide);
      }
    }

    show(text, autoHide) {
      var span = document.createElement('span');
      span.textContent = text;
      this._showNode(span, autoHide || 5000, true);
    }

    hide() {
      if (!this.el) return;
      this.el.style.opacity = '0';
      this.el.style.transform = 'translateY(-8px)';
    }

    showScrobbling(metadata, showInfo) {
      var title = '';
      if (metadata.type === 'episode') {
        var s = String(metadata.season || '?').padStart(2, '0');
        var e = String(metadata.episode || '?').padStart(2, '0');
        var showName = (showInfo && showInfo.trakt_title) || metadata.show;
        var year = (showInfo && showInfo.trakt_year) ? ' (' + showInfo.trakt_year + ')' : '';
        title = showName + year + ' S' + s + 'E' + e;
      } else {
        title = metadata.title || 'Unknown';
      }

      var uncertain = showInfo && showInfo.uncertain;
      var icon = uncertain ? '\u26a0\ufe0f' : '\ud83d\udcfa';
      var color = uncertain ? '#ff9800' : '#4caf50';

      var frag = document.createDocumentFragment();

      var statusSpan = document.createElement('span');
      statusSpan.style.color = color;
      statusSpan.textContent = icon + ' Scrobbling';
      frag.appendChild(statusSpan);

      if (metadata.type === 'episode') {
        var wrongBtn = document.createElement('span');
        wrongBtn.id = 'trakt-wrong-btn';
        wrongBtn.style.cssText =
          'display:inline-block;margin-left:6px;padding:1px 6px;' +
          'background:rgba(255,152,0,0.2);color:#ff9800;border-radius:3px;' +
          'cursor:pointer;font-size:10px;border:1px solid rgba(255,152,0,0.3);';
        wrongBtn.textContent = 'Wrong?';
        frag.appendChild(wrongBtn);
      }

      var titleDiv = document.createElement('div');
      titleDiv.style.cssText = 'font-weight:600;font-size:13px;color:#fff;margin-top:2px;';
      titleDiv.textContent = title;
      frag.appendChild(titleDiv);

      this._showNode(frag, 10000);

      var self = this;
      setTimeout(function() {
        var btn = document.getElementById('trakt-wrong-btn');
        if (btn && self.onWrongShow) {
          btn.addEventListener('click', function(ev) { ev.stopPropagation(); self.onWrongShow(); });
        }
      }, 50);
    }

    showPaused() {
      this.show('\u23f8 Scrobble paused', 3000);
    }

    showStopped() {
      this.show('\u2705 Marked as watched', 5000);
    }

    showNotFound(showTitle) {
      var frag = document.createDocumentFragment();

      var msgDiv = document.createElement('div');
      msgDiv.style.color = '#f44336';
      msgDiv.textContent = '\u26a0\ufe0f "' + showTitle + '" not found on Trakt';
      frag.appendChild(msgDiv);

      var searchBtn = document.createElement('span');
      searchBtn.id = 'trakt-search-btn';
      searchBtn.style.cssText =
        'display:inline-block;margin-top:4px;padding:2px 8px;' +
        'background:rgba(237,28,36,0.2);color:#ed1c24;border-radius:3px;' +
        'cursor:pointer;font-size:11px;border:1px solid rgba(237,28,36,0.3);';
      searchBtn.textContent = 'Search on Trakt';
      frag.appendChild(searchBtn);

      this._showNode(frag, 0);

      var self = this;
      setTimeout(function() {
        var btn = document.getElementById('trakt-search-btn');
        if (btn && self.onWrongShow) {
          btn.addEventListener('click', function(ev) { ev.stopPropagation(); self.onWrongShow(); });
        }
      }, 50);
    }

    showCorrectionMode() {
      var frag = document.createDocumentFragment();

      var pausedDiv = document.createElement('div');
      pausedDiv.style.color = '#64b5f6';
      pausedDiv.textContent = '\u23f8 Video paused';
      frag.appendChild(pausedDiv);

      var hintDiv = document.createElement('div');
      hintDiv.style.cssText = 'margin-top:3px;font-size:11px;color:#aaa;';
      hintDiv.textContent = 'Find the right show on Trakt, then paste the URL in the extension popup.';
      frag.appendChild(hintDiv);

      this._showNode(frag, 0);
    }

    showError(msg) {
      this.show('\u26a0\ufe0f ' + msg, 5000);
    }
  }

  // =====================================================================
  // SCROBBLER -- Core playback tracking
  // =====================================================================

  class Scrobbler {
    constructor(service, overlay) {
      this.service = service;
      this.overlay = overlay;
      this.video = null;
      this.metadata = null;
      this.state = 'idle';
      this.progressTimer = null;
      this.resolvedShowInfo = null;
      this.scrobbleFailed = false;

      this.START_THRESHOLD = 2;
      this.STOP_THRESHOLD = 80;
      this.UPDATE_INTERVAL = 15000;

      this._onPlay = this._onPlay.bind(this);
      this._onPause = this._onPause.bind(this);
      this._onEnded = this._onEnded.bind(this);
      this._onTimeUpdate = this._onTimeUpdate.bind(this);

      var self = this;
      this.overlay.onWrongShow = function() { self._handleWrongShow(); };
    }

    attach() {
      this.video = this.service.getVideoElement();
      if (!this.video) return false;

      this.metadata = this.service.getMetadata();
      if (!this.metadata) {
        console.warn('[Scrobbler] No metadata found on page');
        this.overlay.showError('Could not detect show/movie info');
        return false;
      }

      console.log('[Scrobbler] Attached:', this.metadata);
      api.runtime.sendMessage({ type: 'STATUS', status: 'detected', metadata: this.metadata }).catch(function() {});

      this.video.addEventListener('play', this._onPlay);
      this.video.addEventListener('pause', this._onPause);
      this.video.addEventListener('ended', this._onEnded);
      this.video.addEventListener('timeupdate', this._onTimeUpdate);

      if (!this.video.paused) this._onPlay();
      return true;
    }

    detach() {
      this._stopTimer();
      if (this.video) {
        this.video.removeEventListener('play', this._onPlay);
        this.video.removeEventListener('pause', this._onPause);
        this.video.removeEventListener('ended', this._onEnded);
        this.video.removeEventListener('timeupdate', this._onTimeUpdate);
        this.video = null;
      }
      this.state = 'idle';
      this.metadata = null;
    }

    waitAndAttach(timeout) {
      if (this.attach()) return;
      var self = this;
      console.log('[Scrobbler] Waiting for video element...');
      var observer = new MutationObserver(function() {
        if (self.attach()) observer.disconnect();
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(function() { observer.disconnect(); }, timeout || 30000);
    }

    // -- Wrong show handler -------------------------------------------

    _handleWrongShow() {
      if (this.video && !this.video.paused) this.video.pause();
      this.overlay.showCorrectionMode();
      var query = (this.metadata && this.metadata.show) || (this.metadata && this.metadata.title) || '';
      api.runtime.sendMessage({ type: 'OPEN_TRAKT_SEARCH', query: query }).catch(function() {});
    }

    // -- Video events -------------------------------------------------

    _onPlay() {
      if (this.scrobbleFailed) return;
      if (this.state === 'stopped') return;
      var progress = this._getProgress();
      if (this.state === 'idle' && progress < this.START_THRESHOLD) return;

      this.state = 'playing';
      this._scrobble('start', progress);
      this._startTimer();
    }

    _onPause() {
      if (this.state !== 'playing') return;
      this.state = 'paused';
      this._scrobble('pause', this._getProgress());
      this._stopTimer();
      this.overlay.showPaused();
    }

    _onEnded() {
      if (this.state === 'stopped' || this.scrobbleFailed) return;
      this.state = 'stopped';
      this._scrobble('stop', 100);
      this._stopTimer();
      this.overlay.showStopped();
    }

    _onTimeUpdate() {
      if (this.scrobbleFailed) return;
      var progress = this._getProgress();

      if (this.state === 'idle' && progress >= this.START_THRESHOLD && !this.video.paused) {
        this.state = 'playing';
        this._scrobble('start', progress);
        this._startTimer();
      }

      if (this.state === 'playing' && progress >= this.STOP_THRESHOLD) {
        this.state = 'stopped';
        this._scrobble('stop', progress);
        this._stopTimer();
        this.overlay.showStopped();
      }
    }

    // -- Helpers ------------------------------------------------------

    _getProgress() {
      if (!this.video || !this.video.duration) return 0;
      return (this.video.currentTime / this.video.duration) * 100;
    }

    _scrobble(action, progress) {
      if (!this.metadata) return;
      var p = Math.round(progress * 100) / 100;
      var self = this;
      console.log('[Scrobbler] ' + action + ' ' + p.toFixed(1) + '%', this.metadata);
      api.runtime.sendMessage({
        type: 'SCROBBLE', action: action, metadata: this.metadata, progress: p,
      }).then(function(result) {
        if (!result) return;
        if (result.ok && result.showInfo) {
          self.resolvedShowInfo = result.showInfo;
          if (action === 'start') {
            self.overlay.showScrobbling(self.metadata, result.showInfo);
          }
        }
        if (!result.ok && result.error === 'not_found') {
          self.scrobbleFailed = true;
          self._stopTimer();
          self.overlay.showNotFound(result.showTitle || self.metadata.show || self.metadata.title);
        }
      }).catch(function() {});
    }

    _startTimer() {
      this._stopTimer();
      var self = this;
      this.progressTimer = setInterval(function() {
        if (self.state === 'playing') {
          self._scrobble('start', self._getProgress());
        }
      }, this.UPDATE_INTERVAL);
    }

    _stopTimer() {
      if (this.progressTimer) {
        clearInterval(this.progressTimer);
        this.progressTimer = null;
      }
    }
  }

  // =====================================================================
  // SERVICE REGISTRY
  // =====================================================================

  var SERVICES = [
    RuutuService,
    YleAreenaService,
    MtvKatsomoService,
  ];

  // =====================================================================
  // ENTRY POINT
  // =====================================================================

  var overlay = new Overlay();
  var activeScrobbler = null;

  function start() {
    if (activeScrobbler) {
      activeScrobbler.detach();
      activeScrobbler = null;
    }

    var service = null;
    for (var i = 0; i < SERVICES.length; i++) {
      if (SERVICES[i].match()) { service = new SERVICES[i](); break; }
    }

    if (!service) {
      console.log('[Scrobbler] No matching service for', location.href);
      return;
    }

    console.log('[Scrobbler] Service: ' + service.constructor.name);
    service.init();

    activeScrobbler = new Scrobbler(service, overlay);
    activeScrobbler.waitAndAttach();
  }

  // Listen for correction applied (from popup)
  api.runtime.onMessage.addListener(function(msg) {
    if (msg.type === 'CORRECTION_APPLIED' && activeScrobbler) {
      activeScrobbler.scrobbleFailed = false;
      activeScrobbler.state = 'idle';
      activeScrobbler.resolvedShowInfo = null;
      overlay.show('\u2705 Correction saved -- resuming', 4000);
      if (activeScrobbler.video && activeScrobbler.video.paused) {
        activeScrobbler.video.play(); // triggers 'play' event → _onPlay()
      } else if (activeScrobbler.video && !activeScrobbler.video.paused) {
        activeScrobbler._onPlay(); // already playing, fire manually
      }
    }
  });

  // SPA navigation detection (Next.js)
  var lastUrl = location.href;
  var navObserver = new MutationObserver(function() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      console.log('[Scrobbler] Navigation detected, re-initializing...');
      setTimeout(start, 1500);
    }
  });
  navObserver.observe(document.body, { childList: true, subtree: true });

  // Go
  console.log('[Scrobbler] Content script loaded on', location.href);
  start();
})();
