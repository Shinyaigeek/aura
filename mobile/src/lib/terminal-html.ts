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
  html, body, #term { margin: 0; padding: 0; height: 100%; width: 100%; background: #0b0b0f; }
  body { overflow: hidden; -webkit-tap-highlight-color: transparent; }
  #term { padding: 6px 4px 0 6px; box-sizing: border-box; touch-action: pan-y; }
  .xterm, .xterm-viewport, .xterm-screen { touch-action: pan-y; }
  .xterm .xterm-viewport { background-color: transparent !important; }
  .xterm-selection div { background-color: rgba(122, 162, 247, 0.25) !important; }
</style>
</head>
<body>
<div id="term"></div>
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

    term.onData(function (data) {
      // Fast path: encode input bytes directly to base64 via btoa.
      // data is a JS string of UTF-16 code units; encode to UTF-8 first.
      var bytes = new TextEncoder().encode(data);
      var binary = '';
      for (var i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
      post('i' + btoa(binary));
    });

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
    window.__auraFit = sendResize;
    window.__auraClear = function () { term.clear(); };
    // Serialize the entire active buffer (scrollback + viewport) to UTF-8 text
    // and post it back to RN. The RN side opens a modal with selectable text so
    // the user can pick a region with native handles and hit Copy. We can't
    // rely on in-place selection because xterm's rows set user-select: none and
    // the custom touch handler below claims vertical drags for scrollback.
    function postBufferText(s) {
      var bytes = new TextEncoder().encode(s);
      var binary = '';
      for (var i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
      post('B' + btoa(binary));
    }
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

    window.addEventListener('resize', sendResize);

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
      sendResize();
      post('R');
    });
  })();
</script>
</body>
</html>
`;
