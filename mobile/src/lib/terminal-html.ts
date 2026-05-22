// Static HTML document that hosts xterm.js inside a WebView.
//
// The document loads @xterm/xterm from a CDN and wires up a postMessage
// bridge with the React Native host.
//
//   RN → WebView :  injectJavaScript("window.__auraWrite('<base64>')")
//                    injectJavaScript("window.__auraFit()")
//   WebView → RN :  window.ReactNativeWebView.postMessage("<prefix><payload>")
//
// The outgoing format is a compact prefix scheme instead of JSON, so the
// RN side avoids a JSON.parse per keystroke (noticeable on Android where
// the bridge call is the dominant cost for single-byte inputs):
//
//   "i<base64>"        input bytes typed by the user
//   "r<rows>,<cols>"   viewport resize
//   "R"                xterm is mounted and ready to receive
//   "B<base64>"        full scrollback buffer dump (utf-8), in response to
//                      __auraDumpBuffer() — used by the copy modal
//
// An on-screen key bar (Esc, Tab, ← ↑ ↓ →) sits at the bottom of the
// document. Mobile soft keyboards have no arrow keys, so Claude Code's
// interactive prompts (permission dialogs, plan picker) — which navigate
// with the cursor keys — could not be answered from the app. Each cap
// synthesizes the escape sequence a hardware key would emit and posts it
// through the same "i" channel as a real keystroke. The bar is shown only
// while the soft keyboard is up, and #root is sized to window.visualViewport
// so the terminal + bar stay above the keyboard instead of behind it.
//
// CRITICAL: this string is a TS template literal. Any `\n`, `\t`, `\\`,
// or `${...}` inside the JS below is interpreted at template-expansion
// time, so escape sequences that need to reach the WebView as JS source
// must be doubled (e.g. write `'\\n'` to emit the two-character sequence
// `\n`). `mobile/scripts/check-inline-html.ts` parses the rendered
// `<script>` body in CI to catch regressions of that mistake — which
// shipped silently from v0.0.7 to v0.0.21 and broke cold start on every
// Android build.
export const terminalHtml = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no" />
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.css" />
<style>
  html, body { margin: 0; padding: 0; height: 100%; width: 100%; background: #0b0b0f; }
  body { overflow: hidden; -webkit-tap-highlight-color: transparent; }
  /* #root is pinned to the *visual* viewport — its height is kept in sync
     with window.visualViewport in JS. On iOS the soft keyboard overlays the
     WebView without resizing it, so the bottom rows (where Claude Code draws
     its prompts) would otherwise render behind the keyboard and be
     impossible to read or answer. Sizing #root to the visible area keeps
     the terminal and key bar fully above the keyboard. */
  #root { position: fixed; left: 0; top: 0; width: 100%; height: 100%;
          display: flex; flex-direction: column; }
  /* touch-action: none — must not be pan-y. On Android WebView, pan-y
     hands the vertical drag to the compositor, which downgrades touchmove
     to passive (preventDefault becomes a no-op) and the custom scrollback
     handler below never sees the gesture. */
  #term { flex: 1 1 auto; min-height: 0; padding: 6px 4px 0 6px;
          box-sizing: border-box; touch-action: none; }
  .xterm, .xterm-viewport, .xterm-screen { touch-action: none; }
  .xterm .xterm-viewport { background-color: transparent !important; }
  .xterm-selection div { background-color: rgba(122, 162, 247, 0.25) !important; }

  /* On-screen key bar. Hidden until the soft keyboard is up (xterm's helper
     textarea gains focus); shown as a flex row of equal-width caps. */
  #keybar { flex: 0 0 auto; display: none; flex-direction: row;
            padding: 4px; gap: 4px; background: #14151c;
            border-top: 1px solid #20222c;
            -webkit-user-select: none; user-select: none; }
  #keybar.visible { display: flex; }
  .keycap { flex: 1 1 0; display: flex; align-items: center;
            justify-content: center; height: 38px; border-radius: 8px;
            background: #1c2030; border: 1px solid #2a2d3d;
            color: #c0caf5; font-size: 18px; line-height: 1;
            touch-action: manipulation; -webkit-touch-callout: none; }
  .keycap.pressed { background: #2f3656; border-color: #3b4262; }
  .keycap-label { font-size: 12px; font-weight: 700; letter-spacing: 0.5px;
                  font-family: ui-monospace, Menlo, monospace; }
</style>
</head>
<body>
<div id="root">
  <div id="term"></div>
  <div id="keybar">
    <div class="keycap" data-key="esc"><span class="keycap-label">ESC</span></div>
    <div class="keycap" data-key="tab"><span class="keycap-label">TAB</span></div>
    <div class="keycap" data-key="left">&larr;</div>
    <div class="keycap" data-key="up">&uarr;</div>
    <div class="keycap" data-key="down">&darr;</div>
    <div class="keycap" data-key="right">&rarr;</div>
  </div>
</div>
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.js"></script>
<script>
  (function () {
    var term = new window.Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: 'ui-monospace, "SF Mono", Menlo, "JetBrains Mono", "Fira Code", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      letterSpacing: 0,
      theme: {
        background: '#0b0b0f',
        foreground: '#e4e6ef',
        cursor: '#7aa2f7',
        cursorAccent: '#0b0b0f',
        selectionBackground: 'rgba(122, 162, 247, 0.30)',
        black: '#1a1b26',
        red: '#f7768e',
        green: '#9ece6a',
        yellow: '#e0af68',
        blue: '#7aa2f7',
        magenta: '#bb9af7',
        cyan: '#7dcfff',
        white: '#c0caf5',
        brightBlack: '#414868',
        brightRed: '#ff7a93',
        brightGreen: '#b9f27c',
        brightYellow: '#ff9e64',
        brightBlue: '#8db0ff',
        brightMagenta: '#c7a9ff',
        brightCyan: '#0db9d7',
        brightWhite: '#ffffff',
      },
      allowProposedApi: true,
      scrollback: 10000,
      smoothScrollDuration: 0,
      macOptionIsMeta: true,
    });
    var fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(document.getElementById('term'));

    var rnPost = window.ReactNativeWebView && window.ReactNativeWebView.postMessage;
    function post(s) { if (rnPost) rnPost.call(window.ReactNativeWebView, s); }

    // Encode a JS string to a UTF-8 base64 payload — the wire format shared
    // by the 'i' (input) and 'B' (buffer dump) channels.
    function utf8ToBase64(s) {
      var bytes = new TextEncoder().encode(s);
      var binary = '';
      for (var i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
      return btoa(binary);
    }
    // Send raw bytes to the PTY as user input. Used by xterm's onData (real
    // keystrokes) and by the on-screen key bar (synthesized escape sequences).
    function postInput(s) { post('i' + utf8ToBase64(s)); }

    term.onData(function (data) { postInput(data); });

    function sendResize() {
      try { fit.fit(); } catch (e) {}
      post('r' + term.rows + ',' + term.cols);
    }

    window.__auraWrite = function (b64) {
      var bin = atob(b64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      term.write(bytes);
    };
    window.__auraClear = function () { term.clear(); };
    // Serialize the entire active buffer (scrollback + viewport) to UTF-8 text
    // and post it back to RN. The RN side opens a modal with selectable text so
    // the user can pick a region with native handles and hit Copy. We can't
    // rely on in-place selection because xterm's rows set user-select: none and
    // the custom touch handler below claims vertical drags for scrollback.
    function postBufferText(s) { post('B' + utf8ToBase64(s)); }
    window.__auraDumpBuffer = function () {
      try {
        // Primary: xterm's own selectAll/getSelection. This is what xterm uses
        // internally for clipboard copy — it picks the active buffer (normal vs
        // alternate), reconstructs wrapped lines, and skips trailing blank
        // rows. The previous manual buf.getLine(y).translateToString(true)
        // walk returned empty under tmux/Claude Code's alternate buffer in some
        // cases (presented as "(buffer is empty)" in the modal even with
        // visible content). Manual walk kept as fallback.
        var text = '';
        try {
          term.selectAll();
          text = term.getSelection() || '';
          term.clearSelection();
        } catch (e) {}
        if (!text) {
          var buf = term.buffer.active;
          var lines = [];
          for (var y = 0; y < buf.length; y++) {
            var line = buf.getLine(y);
            lines.push(line ? line.translateToString(true) : '');
          }
          while (lines.length && lines[lines.length - 1] === '') lines.pop();
          text = lines.join('\\n');
        }
        if (!text) {
          var b = term.buffer.active;
          text = '(buffer is empty)\\n[diag] type=' + b.type + ' length=' + b.length +
                 ' baseY=' + b.baseY + ' viewportY=' + b.viewportY +
                 ' cursor=' + b.cursorX + ',' + b.cursorY +
                 ' rows=' + term.rows + ' cols=' + term.cols;
        }
        postBufferText(text);
      } catch (e) {
        postBufferText('(dump failed) ' + (e && e.message ? e.message : String(e)));
      }
    };
    // Focus the helper textarea directly as well as calling term.focus(). On
    // tab switches, term.focus() alone sometimes leaves the hidden textarea
    // unfocused — the native WebView has just regained focus and xterm's
    // focus delegation races the layout pass. Touching the textarea directly
    // is idempotent and cheap.
    window.__auraFocus = function () {
      try {
        term.focus();
        var ta = document.querySelector('.xterm-helper-textarea');
        if (ta && document.activeElement !== ta) ta.focus();
      } catch (e) {}
    };
    // Explicitly release focus before a tab goes offscreen so the OS keyboard
    // detaches from this WebView. Without this, the iOS keyboard may keep
    // delivering IME composition to the hidden textarea, which renders on top
    // of the now-visible tab.
    window.__auraBlur = function () {
      try {
        var ta = document.querySelector('.xterm-helper-textarea');
        if (ta && typeof ta.blur === 'function') ta.blur();
        term.blur();
      } catch (e) {}
    };

    // --- Viewport sizing -------------------------------------------------
    // Keep #root's height pinned to the visible area. On iOS the soft
    // keyboard overlays the WebView without resizing it, so visualViewport
    // is the only signal for how much room is actually left; on Android
    // (adjustResize) the WebView itself shrinks and visualViewport.height
    // tracks it. Sizing #root to visualViewport.height keeps the terminal
    // and key bar fully above the keyboard either way.
    var rootEl = document.getElementById('root');
    function syncViewport() {
      var vv = window.visualViewport;
      if (vv) {
        rootEl.style.height = vv.height + 'px';
        rootEl.style.transform = 'translateY(' + (vv.offsetTop || 0) + 'px)';
      }
      sendResize();
    }
    // Coalesce the bursts of visualViewport events fired during a keyboard
    // open/close animation into one resize per frame.
    var syncScheduled = false;
    function scheduleSync() {
      if (syncScheduled) return;
      syncScheduled = true;
      requestAnimationFrame(function () {
        syncScheduled = false;
        syncViewport();
      });
    }
    window.__auraFit = syncViewport;
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', scheduleSync);
      window.visualViewport.addEventListener('scroll', scheduleSync);
    }
    window.addEventListener('resize', scheduleSync);

    // --- On-screen key bar ----------------------------------------------
    // Soft keyboards have no arrow/Esc/Tab keys, so Claude Code's prompts
    // (navigated with the cursor keys) could not be answered from the app.
    // Each cap synthesizes the escape sequence a hardware key would emit and
    // sends it through the same input channel as a keystroke.
    var keybar = document.getElementById('keybar');
    // Cursor keys flip between CSI ('\\x1b[A') and SS3 ('\\x1bOA') form
    // depending on DECCKM (application cursor keys mode). xterm tracks the
    // mode the running program asked for; mirror it so the arrows behave
    // exactly like a physical keyboard under tmux + Claude Code.
    function cursorSeq(letter) {
      var app = false;
      try { app = !!(term.modes && term.modes.applicationCursorKeysMode); } catch (e) {}
      return '\\x1b' + (app ? 'O' : '[') + letter;
    }
    function keySeq(key) {
      if (key === 'esc') return '\\x1b';
      if (key === 'tab') return '\\t';
      if (key === 'up') return cursorSeq('A');
      if (key === 'down') return cursorSeq('B');
      if (key === 'right') return cursorSeq('C');
      if (key === 'left') return cursorSeq('D');
      return '';
    }
    var caps = keybar.querySelectorAll('.keycap');
    for (var c = 0; c < caps.length; c++) {
      (function (cap) {
        var key = cap.getAttribute('data-key');
        // Handle on pointerdown, not click: preventDefault here keeps the
        // hidden textarea focused (the cap is a non-focusable <div>), so the
        // soft keyboard does not dismiss between presses while the user is
        // stepping through a prompt's options.
        cap.addEventListener('pointerdown', function (e) {
          e.preventDefault();
          var seq = keySeq(key);
          if (seq) postInput(seq);
          cap.classList.add('pressed');
        }, { passive: false });
        function release() { cap.classList.remove('pressed'); }
        cap.addEventListener('pointerup', release);
        cap.addEventListener('pointercancel', release);
        cap.addEventListener('pointerleave', release);
      })(caps[c]);
    }
    // Tie the bar's visibility to the keyboard: xterm's helper textarea is
    // focused exactly when the soft keyboard is up. Re-fit on every toggle
    // so the bar's strip of height is taken from the terminal, not painted
    // over the bottom row of output.
    function setKeybar(visible) {
      if (keybar.classList.contains('visible') === visible) return;
      keybar.classList.toggle('visible', visible);
      scheduleSync();
    }
    var helperTextarea = document.querySelector('.xterm-helper-textarea');
    if (helperTextarea) {
      helperTextarea.addEventListener('focus', function () { setKeybar(true); });
      helperTextarea.addEventListener('blur', function () { setKeybar(false); });
    }

    // Touch-drag scrollback. xterm-screen sits on top of xterm-viewport and
    // absorbs pointer events, so native overflow-scroll on the viewport never
    // fires from a swipe. Translate single-finger vertical drags into
    // term.scrollLines() calls; short taps still fall through to xterm so the
    // keyboard comes up.
    var termEl = document.getElementById('term');
    var touchStartY = 0;
    var touchStartX = 0;
    var touchLastY = 0;
    var touchScrolling = false;
    var touchAccum = 0;
    termEl.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) return;
      touchStartY = touchLastY = e.touches[0].clientY;
      touchStartX = e.touches[0].clientX;
      touchScrolling = false;
      touchAccum = 0;
    }, { passive: true });
    termEl.addEventListener('touchmove', function (e) {
      if (e.touches.length !== 1) return;
      var y = e.touches[0].clientY;
      var x = e.touches[0].clientX;
      if (!touchScrolling) {
        var dy = y - touchStartY;
        var dx = x - touchStartX;
        if (Math.abs(dy) <= 8 || Math.abs(dy) <= Math.abs(dx)) return;
        touchScrolling = true;
      }
      e.preventDefault();
      var lineH = term.options.fontSize * term.options.lineHeight;
      if (!lineH || lineH <= 0) lineH = 16;
      touchAccum += (touchLastY - y) / lineH;
      touchLastY = y;
      var lines = touchAccum > 0 ? Math.floor(touchAccum) : Math.ceil(touchAccum);
      if (lines !== 0) {
        term.scrollLines(lines);
        touchAccum -= lines;
      }
    }, { passive: false });

    // Initial handshake once layout has settled.
    requestAnimationFrame(function () {
      syncViewport();
      post('R');
    });
  })();
</script>
</body>
</html>
`;
