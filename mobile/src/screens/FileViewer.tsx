import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { bytesToBase64 } from "@/lib/base64";
import { fileViewerHtml } from "@/lib/file-viewer-html";
import type { ReadfileResponse, WsClient } from "@/lib/ws";

type Props = {
  client: WsClient | null;
  path: string;
  onClose: () => void;
};

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: ReadfileResponse };

export default function FileViewer({ client, path, onClose }: Props) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const webRef = useRef<WebView | null>(null);
  const webReadyRef = useRef(false);
  const pendingPayloadRef = useRef<string | null>(null);

  const filename = useMemo(() => path.split("/").pop() || path, [path]);
  const langHint = useMemo(() => detectLang(filename), [filename]);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    if (!client) {
      setState({ kind: "error", message: "Not connected" });
      return () => {
        cancelled = true;
      };
    }
    client
      .request<ReadfileResponse>({ type: "readfile", path }, 15_000)
      .then((res) => {
        if (cancelled) return;
        setState({ kind: "ready", data: res });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [client, path]);

  // When we have content AND the WebView is ready, push the payload in. If
  // the content lands first, stash it and let the 'R' handshake flush.
  useEffect(() => {
    if (state.kind !== "ready") return;
    const data = state.data;
    const contentB64 = data.binary ? "" : utf8ToBase64(data.content);
    const payload = JSON.stringify({
      contentB64,
      langHint,
      binary: data.binary,
      truncated: data.truncated,
      shownBytes: data.binary ? 0 : new TextEncoder().encode(data.content).byteLength,
      totalBytes: data.size,
    });
    if (webReadyRef.current && webRef.current) {
      webRef.current.injectJavaScript(
        `window.__auraSetContent&&window.__auraSetContent(${JSON.stringify(payload)});true;`,
      );
    } else {
      pendingPayloadRef.current = payload;
    }
  }, [state, langHint]);

  const onWebMessage = useCallback((event: WebViewMessageEvent) => {
    const raw = event.nativeEvent.data;
    if (raw === "R") {
      webReadyRef.current = true;
      const pending = pendingPayloadRef.current;
      if (pending && webRef.current) {
        pendingPayloadRef.current = null;
        webRef.current.injectJavaScript(
          `window.__auraSetContent&&window.__auraSetContent(${JSON.stringify(pending)});true;`,
        );
      }
    }
  }, []);

  const source = useMemo(() => ({ html: fileViewerHtml, baseUrl: "https://aura.local/" }), []);

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      <View style={styles.header}>
        <View style={styles.headerTextWrap}>
          <Text style={styles.title} numberOfLines={1}>
            {filename}
          </Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {path}
          </Text>
        </View>
        <Pressable
          onPress={onClose}
          hitSlop={10}
          style={({ pressed }) => [styles.closeBtn, pressed && { opacity: 0.5 }]}
        >
          <Text style={styles.closeText}>×</Text>
        </Pressable>
      </View>

      {state.kind === "loading" && (
        <View style={styles.center}>
          <ActivityIndicator color="#7aa2f7" />
        </View>
      )}

      {state.kind === "error" && (
        <ScrollView contentContainerStyle={styles.center}>
          <Text style={styles.errorText}>{state.message}</Text>
        </ScrollView>
      )}

      {state.kind === "ready" && (
        <WebView
          ref={webRef}
          originWhitelist={["*"]}
          source={source}
          onMessage={onWebMessage}
          javaScriptEnabled
          domStorageEnabled
          setSupportMultipleWindows={false}
          style={styles.web}
          automaticallyAdjustContentInsets={false}
          contentInsetAdjustmentBehavior="never"
          overScrollMode="never"
          androidLayerType={Platform.OS === "android" ? "hardware" : undefined}
        />
      )}
    </SafeAreaView>
  );
}

// utf8ToBase64 converts a JS string to a UTF-8 base64 string. RN's btoa only
// accepts Latin-1, and naïve String.fromCharCode round-trips lose any
// multi-byte character (Japanese, emoji), so we go through TextEncoder.
function utf8ToBase64(s: string): string {
  return bytesToBase64(new TextEncoder().encode(s));
}

function detectLang(filename: string): string | null {
  const lower = filename.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = lower.slice(dot + 1);
  return EXT_TO_LANG[ext] ?? null;
}

// Mapping curated for the languages users in this codebase actually open.
// highlightAuto handles the long tail when extension is unknown.
const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  go: "go",
  py: "python",
  rb: "ruby",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  json: "json",
  md: "markdown",
  markdown: "markdown",
  html: "xml",
  xml: "xml",
  css: "css",
  scss: "scss",
  sql: "sql",
  dockerfile: "dockerfile",
  makefile: "makefile",
  mk: "makefile",
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0b0b0f" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 6,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#1a1c26",
  },
  headerTextWrap: { flex: 1, marginRight: 12 },
  title: {
    color: "#e4e6ef",
    fontSize: 16,
    fontWeight: "600",
    letterSpacing: 0.2,
  },
  subtitle: {
    color: "#6b7089",
    fontSize: 11,
    marginTop: 2,
    fontFamily: Platform.select({
      ios: "Menlo",
      android: "monospace",
      default: "monospace",
    }),
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#14151c",
    borderWidth: 1,
    borderColor: "#20222c",
  },
  closeText: {
    color: "#c0caf5",
    fontSize: 20,
    lineHeight: 22,
    fontWeight: "600",
  },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  errorText: { color: "#f7768e", fontSize: 14, textAlign: "center" },
  web: { flex: 1, backgroundColor: "#0b0b0f" },
});
