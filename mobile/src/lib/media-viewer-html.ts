// Static HTML for the shared-media viewer WebView.
//
// Mirrors the file-viewer-html.ts pattern: a self-contained document that
// exposes window.__auraSetMedia(payloadJson), which the React Native host
// calls via injectJavaScript once it knows what to show. The host also gets a
// one-shot 'R' postMessage when the WebView is ready so it can flush the
// payload if it arrived before the document finished loading.
//
// The WebView is loaded with baseUrl set to the server's http origin, so the
// media src (an absolute http URL with a ?token= param) is same-origin and
// renders without any mixed-content trouble — the same reason the difit
// WebView loads plain http cleanly.
//
// CRITICAL — same caveat as terminal-html.ts / file-viewer-html.ts: this is a
// TS template literal, so any \n, \t, \\ or ${...} inside the inline <script>
// reaches the runtime expanded. Keep the script free of those sequences;
// mobile/scripts/check-inline-html.ts parses it in CI to catch regressions.

export const mediaViewerHtml = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=4,user-scalable=yes" />
<style>
  html, body { margin: 0; padding: 0; height: 100%; width: 100%; background: #0b0b0f; color: #e4e6ef; }
  body { display: flex; align-items: center; justify-content: center; -webkit-tap-highlight-color: transparent; }
  #root { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }
  img, video { max-width: 100%; max-height: 100%; object-fit: contain; display: block; }
  .placeholder {
    padding: 24px;
    text-align: center;
    color: #8b90a8;
    font-family: ui-monospace, Menlo, monospace;
    font-size: 13px;
    line-height: 1.5;
  }
  .placeholder a { color: #7aa2f7; word-break: break-all; }
</style>
</head>
<body>
<div id="root"><div class="placeholder">Loading…</div></div>
<script>
  (function () {
    var rnPost = window.ReactNativeWebView && window.ReactNativeWebView.postMessage;
    function post(s) { if (rnPost) rnPost.call(window.ReactNativeWebView, s); }

    function placeholder(text, href) {
      var root = document.getElementById('root');
      if (!root) return;
      root.innerHTML = '';
      var div = document.createElement('div');
      div.className = 'placeholder';
      div.textContent = text;
      if (href) {
        var br = document.createElement('br');
        div.appendChild(br);
        var a = document.createElement('a');
        a.href = href;
        a.textContent = 'Open file';
        div.appendChild(a);
      }
      root.appendChild(div);
    }

    function render(state) {
      var root = document.getElementById('root');
      if (!root) return;
      if (state.kind === 'image') {
        root.innerHTML = '';
        var img = document.createElement('img');
        img.src = state.src;
        img.alt = state.name || '';
        img.onerror = function () { placeholder('Could not load image.', state.src); };
        root.appendChild(img);
        return;
      }
      if (state.kind === 'video') {
        root.innerHTML = '';
        var v = document.createElement('video');
        v.src = state.src;
        v.controls = true;
        v.autoplay = true;
        v.playsInline = true;
        v.setAttribute('playsinline', '');
        v.onerror = function () { placeholder('Could not play video.', state.src); };
        root.appendChild(v);
        return;
      }
      placeholder((state.name || 'This file') + ' cannot be previewed.', state.src);
    }

    window.__auraSetMedia = function (payloadJson) {
      try {
        var p = JSON.parse(payloadJson);
        render({ kind: p.kind || 'other', src: p.src || '', name: p.name || '' });
      } catch (e) {
        placeholder('Failed to render: ' + (e && e.message ? e.message : String(e)));
      }
    };

    requestAnimationFrame(function () { post('R'); });
  })();
</script>
</body>
</html>
`;
