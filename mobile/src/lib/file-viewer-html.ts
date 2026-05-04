// Static HTML for the syntax-highlighted file viewer WebView.
//
// Mirrors the terminal-html.ts pattern: load highlight.js from a CDN, expose
// `window.__auraSetContent(b64, langHint)` that the React Native host calls
// via injectJavaScript with the file content (UTF-8 base64 encoded — Unicode-
// safe, and matches how terminal-html receives its xterm bytes), highlight,
// and render. The host also gets a one-shot 'R' postMessage when the WebView
// is ready, so it can flush content if the load arrived first.
//
// CRITICAL — same caveat as terminal-html.ts: this is a TS template literal,
// so any `\n`, `\t`, `\\` or `${...}` inside the inline <script> reaches the
// runtime expanded. `mobile/scripts/check-inline-html.ts` parses both inline
// scripts in CI to catch escape regressions.

export const fileViewerHtml = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no" />
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.10.0/build/styles/tokyo-night-dark.min.css" />
<style>
  html, body { margin: 0; padding: 0; height: 100%; width: 100%; background: #0b0b0f; color: #e4e6ef; }
  body { -webkit-tap-highlight-color: transparent; }
  pre { margin: 0; }
  pre.code {
    display: block;
    padding: 12px 14px 32px 14px;
    font-family: ui-monospace, "SF Mono", Menlo, "JetBrains Mono", "Fira Code", monospace;
    font-size: 12.5px;
    line-height: 1.45;
    white-space: pre;
    overflow-x: auto;
  }
  pre.code code.hljs { padding: 0; background: transparent; }
  .placeholder {
    padding: 20px;
    color: #8b90a8;
    font-family: ui-monospace, Menlo, monospace;
    font-size: 13px;
  }
  .truncated {
    position: sticky;
    bottom: 0;
    background: rgba(20, 21, 28, 0.95);
    color: #e0af68;
    font-size: 12px;
    padding: 6px 14px;
    border-top: 1px solid #2a2d3d;
    text-align: center;
  }
</style>
</head>
<body>
<div id="root"><div class="placeholder">Loading…</div></div>
<script src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.10.0/build/highlight.min.js"></script>
<script>
  (function () {
    var rnPost = window.ReactNativeWebView && window.ReactNativeWebView.postMessage;
    function post(s) { if (rnPost) rnPost.call(window.ReactNativeWebView, s); }

    function decodeBase64Utf8(b64) {
      var bin = atob(b64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      try { return new TextDecoder('utf-8').decode(bytes); } catch (e) { return bin; }
    }

    function render(state) {
      var root = document.getElementById('root');
      if (!root) return;
      if (state.binary) {
        root.innerHTML = '';
        var ph = document.createElement('div');
        ph.className = 'placeholder';
        ph.textContent = '(binary file — no preview)';
        root.appendChild(ph);
        return;
      }
      var pre = document.createElement('pre');
      pre.className = 'code';
      var code = document.createElement('code');
      code.className = 'hljs';
      var lang = state.langHint && window.hljs && window.hljs.getLanguage(state.langHint)
        ? state.langHint
        : null;
      try {
        if (lang) {
          var r = window.hljs.highlight(state.text, { language: lang, ignoreIllegals: true });
          code.innerHTML = r.value;
        } else if (window.hljs && window.hljs.highlightAuto) {
          var auto = window.hljs.highlightAuto(state.text);
          code.innerHTML = auto.value;
        } else {
          code.textContent = state.text;
        }
      } catch (e) {
        code.textContent = state.text;
      }
      pre.appendChild(code);
      root.innerHTML = '';
      root.appendChild(pre);
      if (state.truncated) {
        var tr = document.createElement('div');
        tr.className = 'truncated';
        tr.textContent = 'Truncated — showing first ' + state.shownBytes + ' of ' + state.totalBytes + ' bytes';
        root.appendChild(tr);
      }
    }

    window.__auraSetContent = function (payloadJson) {
      try {
        var p = JSON.parse(payloadJson);
        render({
          text: p.contentB64 ? decodeBase64Utf8(p.contentB64) : '',
          langHint: p.langHint || null,
          binary: !!p.binary,
          truncated: !!p.truncated,
          shownBytes: p.shownBytes || 0,
          totalBytes: p.totalBytes || 0,
        });
      } catch (e) {
        var root = document.getElementById('root');
        if (root) {
          root.innerHTML = '';
          var ph = document.createElement('div');
          ph.className = 'placeholder';
          ph.textContent = '(failed to render: ' + (e && e.message ? e.message : String(e)) + ')';
          root.appendChild(ph);
        }
      }
    };

    requestAnimationFrame(function () { post('R'); });
  })();
</script>
</body>
</html>
`;
