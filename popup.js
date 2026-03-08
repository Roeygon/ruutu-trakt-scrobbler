// Popup Script -- Device Auth + Now Playing + Checkin + Corrections
var api = typeof browser !== 'undefined' ? browser : chrome;

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
      tag.textContent = 'Now Playing -- TV';
      var showName = (info && info.trakt_title) || m.show || 'Unknown Show';
      var year = (info && info.trakt_year) ? ' (' + info.trakt_year + ')' : '';
      title.textContent = showName + year;
      var se = 'S' + String(m.season || 0).padStart(2, '0') + 'E' + String(m.episode || 0).padStart(2, '0');
      sub.textContent = se + (m.title ? ' -- ' + m.title : '');

      // Show correction section for episodes
      var correctSec = document.getElementById('correctSec');
      if (correctSec) correctSec.classList.remove('hidden');
    } else {
      tag.textContent = 'Now Playing -- Movie';
      title.textContent = m.title || 'Unknown';
      sub.textContent = m.year ? '(' + m.year + ')' : '';
    }

    // Checkin handler
    document.getElementById('checkinBtn').onclick = async function() {
      var msg = document.getElementById('checkinMsg');
      msg.innerHTML = '<div class="msg msg-info"><span class="spin"></span> Checking in...</div>';
      var r = await api.runtime.sendMessage({ type: 'CHECKIN', metadata: m });
      msg.innerHTML = r.ok
        ? '<div class="msg msg-ok">\u2713 Checked in!</div>'
        : '<div class="msg msg-err">' + (r.error || 'Failed') + '</div>';
    };
  }

  // -- Device Auth ----------------------------------------------------

  document.getElementById('authBtn').onclick = async function() {
    var codeArea = document.getElementById('codeArea');
    var authMsg  = document.getElementById('authMsg');

    authMsg.innerHTML = '<div class="msg msg-info"><span class="spin"></span> Requesting code...</div>';

    var r = await api.runtime.sendMessage({ type: 'DEVICE_AUTH_START' });
    if (!r.ok) {
      authMsg.innerHTML = '<div class="msg msg-err">' + r.error + '</div>';
      return;
    }

    authMsg.innerHTML = '';
    codeArea.innerHTML =
      '<div class="code-box">' +
        '<div class="sm">Enter this code at Trakt:</div>' +
        '<div class="code">' + r.user_code + '</div>' +
        '<a class="link" href="' + r.verification_url + '" target="_blank">' +
          'Open ' + r.verification_url +
        '</a>' +
        '<div class="sm" style="margin-top:10px">' +
          '<span class="spin"></span> Waiting for you to authorize...' +
        '</div>' +
      '</div>';

    var p = await api.runtime.sendMessage({
      type: 'DEVICE_AUTH_POLL',
      deviceCode: r.device_code,
      interval: r.interval,
    });

    if (p.ok) {
      codeArea.innerHTML = '';
      authMsg.innerHTML = '<div class="msg msg-ok">\u2713 Connected to Trakt!</div>';
      setTimeout(function() {
        authSec.classList.add('hidden');
        connSec.classList.remove('hidden');
        dot.className = 'dot dot-g';
        statusTxt.textContent = 'Connected & scrobbling';
      }, 1000);
    } else {
      codeArea.innerHTML = '';
      authMsg.innerHTML = '<div class="msg msg-err">' + p.error + '</div>';
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
        correctMsg.innerHTML = '<div class="msg msg-err">Paste a Trakt URL</div>';
        return;
      }

      correctMsg.innerHTML = '<div class="msg msg-info"><span class="spin"></span> Resolving...</div>';

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
        correctMsg.innerHTML = '<div class="msg msg-ok">\u2713 Saved: ' + esc(r.info.trakt_title) + yr + '</div>';
        correctUrl.value = '';

        // Notify content script to resume
        var tabs = await api.tabs.query({ url: 'https://www.ruutu.fi/video/*' });
        for (var i = 0; i < tabs.length; i++) {
          api.tabs.sendMessage(tabs[i].id, { type: 'CORRECTION_APPLIED' }).catch(function() {});
        }

        loadCorrections();
      } else {
        correctMsg.innerHTML = '<div class="msg msg-err">' + (r.error || 'Failed') + '</div>';
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
    var html = '';
    for (var i = 0; i < entries.length; i++) {
      var source = entries[i][0];
      var info = entries[i][1];
      var yr = info.trakt_year ? info.trakt_year : '?';
      html +=
        '<div style="display:flex;align-items:center;justify-content:space-between;' +
        'padding:4px 0;border-bottom:1px solid #252545;">' +
          '<div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">' +
            '<span style="color:#888;">' + esc(source) + '</span>' +
            ' \u2192 <span style="color:#fff;">' + esc(info.trakt_title) + ' (' + yr + ')</span>' +
          '</div>' +
          '<span class="del-correction" data-source="' + esc(source) + '" style="' +
          'color:#f44336;cursor:pointer;padding:2px 6px;font-size:10px;flex-shrink:0;' +
          '">\u2715</span>' +
        '</div>';
    }
    list.innerHTML = html;

    var delBtns = list.querySelectorAll('.del-correction');
    for (var j = 0; j < delBtns.length; j++) {
      delBtns[j].onclick = async function() {
        await api.runtime.sendMessage({ type: 'REMOVE_CORRECTION', sourceTitle: this.dataset.source });
        loadCorrections();
      };
    }
  }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  loadCorrections();
});
