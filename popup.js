// Popup Script -- Device Auth + Now Playing + Checkin + Corrections
var api = typeof browser !== 'undefined' ? browser : chrome;

// -- DOM helpers --------------------------------------------------------

function mkEl(tag) { return document.createElement(tag); }

function clearEl(el) { el.textContent = ''; }

function setMsg(container, cssClass, text) {
  clearEl(container);
  var d = mkEl('div');
  d.className = 'msg ' + cssClass;
  d.textContent = text;
  container.appendChild(d);
}

function setSpinMsg(container, cssClass, text) {
  clearEl(container);
  var d = mkEl('div');
  d.className = 'msg ' + cssClass;
  var s = mkEl('span');
  s.className = 'spin';
  d.appendChild(s);
  d.appendChild(document.createTextNode(' ' + text));
  container.appendChild(d);
}

// -----------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async function() {
  var dot       = document.getElementById('dot');
  var statusTxt = document.getElementById('statusText');
  var authSec   = document.getElementById('authSec');
  var connSec   = document.getElementById('connSec');
  var npBox     = document.getElementById('npBox');

  // -- Check Status ---------------------------------------------------

  try {
    var s = await api.runtime.sendMessage({ type: 'GET_STATUS' });

    if (s.authenticated) {
      authSec.classList.add('hidden');
      connSec.classList.remove('hidden');
      dot.className = 'dot dot-g';
      statusTxt.textContent = 'Connected & scrobbling';

      if (s.nowPlaying) showNowPlaying(s.nowPlaying, s.nowPlayingInfo);
    } else {
      authSec.classList.remove('hidden');
      connSec.classList.add('hidden');
      dot.className = 'dot dot-y';
      statusTxt.textContent = 'Not connected';
    }
  } catch (e) {
    statusTxt.textContent = 'Error';
  }

  // -- Now Playing ----------------------------------------------------

  function showNowPlaying(m, info) {
    npBox.classList.remove('hidden');
    var tag   = document.getElementById('npTag');
    var title = document.getElementById('npTitle');
    var sub   = document.getElementById('npSub');

    if (m.type === 'episode') {
      tag.textContent = 'Now Playing \u2014 TV';
      var showName = (info && info.trakt_title) || m.show || 'Unknown Show';
      var year = (info && info.trakt_year) ? ' (' + info.trakt_year + ')' : '';
      title.textContent = showName + year;
      var se = 'S' + String(m.season || 0).padStart(2, '0') + 'E' + String(m.episode || 0).padStart(2, '0');
      sub.textContent = se + (m.title ? ' \u2014 ' + m.title : '');

      var correctSec = document.getElementById('correctSec');
      if (correctSec) correctSec.classList.remove('hidden');
    } else {
      tag.textContent = 'Now Playing \u2014 Movie';
      title.textContent = m.title || 'Unknown';
      sub.textContent = m.year ? '(' + m.year + ')' : '';
    }

    document.getElementById('checkinBtn').onclick = async function() {
      var msgEl = document.getElementById('checkinMsg');
      setSpinMsg(msgEl, 'msg-info', 'Checking in...');
      var r = await api.runtime.sendMessage({ type: 'CHECKIN', metadata: m });
      setMsg(msgEl, r.ok ? 'msg-ok' : 'msg-err', r.ok ? '\u2713 Checked in!' : (r.error || 'Failed'));
    };
  }

  // -- Device Auth ----------------------------------------------------

  document.getElementById('authBtn').onclick = async function() {
    var codeArea = document.getElementById('codeArea');
    var authMsg  = document.getElementById('authMsg');

    setSpinMsg(authMsg, 'msg-info', 'Requesting code...');

    var r = await api.runtime.sendMessage({ type: 'DEVICE_AUTH_START' });
    if (!r.ok) {
      setMsg(authMsg, 'msg-err', r.error);
      return;
    }

    clearEl(authMsg);

    // Build device code box with DOM
    var box = mkEl('div');
    box.className = 'code-box';

    var label = mkEl('div');
    label.className = 'sm';
    label.textContent = 'Enter this code at Trakt:';
    box.appendChild(label);

    var codeDiv = mkEl('div');
    codeDiv.className = 'code';
    codeDiv.textContent = r.user_code;
    box.appendChild(codeDiv);

    var link = mkEl('a');
    link.className = 'link';
    link.href = r.verification_url;
    link.target = '_blank';
    link.textContent = 'Open ' + r.verification_url;
    box.appendChild(link);

    var waiting = mkEl('div');
    waiting.className = 'sm';
    waiting.style.marginTop = '10px';
    var ws = mkEl('span');
    ws.className = 'spin';
    waiting.appendChild(ws);
    waiting.appendChild(document.createTextNode(' Waiting for you to authorize...'));
    box.appendChild(waiting);

    clearEl(codeArea);
    codeArea.appendChild(box);

    var p = await api.runtime.sendMessage({
      type: 'DEVICE_AUTH_POLL',
      deviceCode: r.device_code,
      interval: r.interval,
    });

    clearEl(codeArea);
    if (p.ok) {
      setMsg(authMsg, 'msg-ok', '\u2713 Connected to Trakt!');
      setTimeout(function() {
        authSec.classList.add('hidden');
        connSec.classList.remove('hidden');
        dot.className = 'dot dot-g';
        statusTxt.textContent = 'Connected & scrobbling';
      }, 1000);
    } else {
      setMsg(authMsg, 'msg-err', p.error);
    }
  };

  // -- Logout ---------------------------------------------------------

  document.getElementById('logoutBtn').onclick = async function() {
    await api.runtime.sendMessage({ type: 'LOGOUT' });
    connSec.classList.add('hidden');
    npBox.classList.add('hidden');
    authSec.classList.remove('hidden');
    dot.className = 'dot dot-y';
    statusTxt.textContent = 'Disconnected';
  };

  // -- Correction: fix wrong show match -------------------------------

  var correctBtn = document.getElementById('correctBtn');
  var correctUrl = document.getElementById('correctUrl');
  var correctMsg = document.getElementById('correctMsg');

  if (correctBtn) {
    correctBtn.onclick = async function() {
      var url = correctUrl.value.trim();
      if (!url) {
        setMsg(correctMsg, 'msg-err', 'Paste a Trakt URL');
        return;
      }

      setSpinMsg(correctMsg, 'msg-info', 'Resolving...');

      var status = await api.runtime.sendMessage({ type: 'GET_STATUS' });
      var sourceTitle = '';
      if (status.nowPlaying) {
        sourceTitle = status.nowPlaying.show || status.nowPlaying.title || '';
      }

      var r = await api.runtime.sendMessage({
        type: 'RESOLVE_URL', url: url, sourceTitle: sourceTitle,
      });

      if (r.ok) {
        var yr = r.info.trakt_year ? ' (' + r.info.trakt_year + ')' : '';
        setMsg(correctMsg, 'msg-ok', '\u2713 Saved: ' + r.info.trakt_title + yr);
        correctUrl.value = '';

        var tabs = await api.tabs.query({ url: 'https://www.ruutu.fi/video/*' });
        for (var i = 0; i < tabs.length; i++) {
          api.tabs.sendMessage(tabs[i].id, { type: 'CORRECTION_APPLIED' }).catch(function() {});
        }

        loadCorrections();
      } else {
        setMsg(correctMsg, 'msg-err', r.error || 'Failed');
      }
    };
  }

  // -- Saved Corrections List -----------------------------------------

  async function loadCorrections() {
    var corrections = await api.runtime.sendMessage({ type: 'GET_CORRECTIONS' });
    var sec = document.getElementById('correctionsSec');
    var list = document.getElementById('correctionsList');
    if (!sec || !list) return;

    var entries = Object.entries(corrections || {});
    if (entries.length === 0) { sec.classList.add('hidden'); return; }

    sec.classList.remove('hidden');
    clearEl(list);

    for (var i = 0; i < entries.length; i++) {
      var source = entries[i][0];
      var info = entries[i][1];
      var yr = info.trakt_year ? info.trakt_year : '?';

      var row = mkEl('div');
      row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;' +
        'padding:4px 0;border-bottom:1px solid #252545;';

      var lbl = mkEl('div');
      lbl.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;';

      var srcSpan = mkEl('span');
      srcSpan.style.color = '#888';
      srcSpan.textContent = source;
      lbl.appendChild(srcSpan);

      lbl.appendChild(document.createTextNode(' \u2192 '));

      var tgtSpan = mkEl('span');
      tgtSpan.style.color = '#fff';
      tgtSpan.textContent = info.trakt_title + ' (' + yr + ')';
      lbl.appendChild(tgtSpan);

      var delBtn = mkEl('span');
      delBtn.style.cssText = 'color:#f44336;cursor:pointer;padding:2px 6px;font-size:10px;flex-shrink:0;';
      delBtn.textContent = '\u2715';
      delBtn.onclick = (function(src) {
        return async function() {
          await api.runtime.sendMessage({ type: 'REMOVE_CORRECTION', sourceTitle: src });
          loadCorrections();
        };
      })(source);

      row.appendChild(lbl);
      row.appendChild(delBtn);
      list.appendChild(row);
    }
  }

  loadCorrections();
});
