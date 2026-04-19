// Static HTML document that hosts xterm.js inside a WebView.
//
// The document loads @xterm/xterm from a CDN and wires up a postMessage
// bridge with the React Native host:
//
//   RN → WebView :  injectJavaScript("window.__auraWrite('<base64>')")
//                    injectJavaScript("window.__auraFit()")
//   WebView → RN :  window.ReactNativeWebView.postMessage(JSON.stringify(...))
//       Outgoing message shapes:
//         { kind: "input", data: "<base64>" }
//         { kind: "resize", rows, cols }
//         { kind: "ready" }
//
// We keep this string separate so the TerminalScreen stays focused on
// orchestration rather than raw HTML.
export const terminalHtml = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no" />
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.css" />
<style>
  html, body, #term { margin: 0; padding: 0; height: 100%; width: 100%; background: #0b0b0b; }
  body { overflow: hidden; }
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
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      theme: {
        background: '#0b0b0b',
        foreground: '#e5e5e5',
        cursor: '#e5e5e5',
      },
      allowProposedApi: true,
      scrollback: 10000,
    });
    var fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(document.getElementById('term'));

    function post(msg) {
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(JSON.stringify(msg));
      }
    }

    term.onData(function (data) {
      var bytes = new TextEncoder().encode(data);
      var binary = '';
      for (var i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
      post({ kind: 'input', data: btoa(binary) });
    });

    function sendResize() {
      try { fit.fit(); } catch (e) {}
      post({ kind: 'resize', rows: term.rows, cols: term.cols });
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
      post({ kind: 'ready' });
    });
  })();
</script>
</body>
</html>
`;
