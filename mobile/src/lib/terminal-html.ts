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
export const terminalHtml = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no" />
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.css" />
<style>
  html, body, #term { margin: 0; padding: 0; height: 100%; width: 100%; background: #0b0b0f; }
  body { overflow: hidden; -webkit-tap-highlight-color: transparent; }
  #term { padding: 6px 4px 0 6px; box-sizing: border-box; }
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
    window.__auraFocus = function () { term.focus(); };

    window.addEventListener('resize', sendResize);

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
