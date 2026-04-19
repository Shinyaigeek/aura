import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  type AppStateStatus,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import type { RootStackParamList } from "../../App";
import { base64ToBytes, bytesToBase64 } from "@/lib/base64";
import { loadConfig, type ServerConfig } from "@/lib/storage";
import { terminalHtml } from "@/lib/terminal-html";
import { WsClient, type WsStatus } from "@/lib/ws";

type Props = NativeStackScreenProps<RootStackParamList, "Terminal">;

export default function TerminalScreen({ navigation }: Props) {
  const [cfg, setCfg] = useState<ServerConfig | null>(null);
  const [status, setStatus] = useState<WsStatus>("closed");
  const webRef = useRef<WebView | null>(null);
  const clientRef = useRef<WsClient | null>(null);
  const webReadyRef = useRef(false);
  const pendingFramesRef = useRef<Uint8Array[]>([]);
  const flushScheduledRef = useRef(false);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      loadConfig().then((c) => {
        if (!cancelled) setCfg(c);
      });
      return () => {
        cancelled = true;
      };
    }, []),
  );

  useEffect(() => {
    navigation.setOptions({
      headerTitle: () => <HeaderTitle status={status} />,
      headerRight: () => (
        <Pressable
          onPress={() => navigation.navigate("Settings")}
          hitSlop={10}
          style={({ pressed }) => [styles.headerIconButton, pressed && { opacity: 0.55 }]}
        >
          <Text style={styles.headerIcon}>⚙</Text>
        </Pressable>
      ),
    });
  }, [navigation, status]);

  const flushPending = useCallback(() => {
    flushScheduledRef.current = false;
    const frames = pendingFramesRef.current;
    if (frames.length === 0) return;
    pendingFramesRef.current = [];

    let total = 0;
    for (const f of frames) total += f.byteLength;
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const f of frames) {
      merged.set(f, offset);
      offset += f.byteLength;
    }
    const b64 = bytesToBase64(merged);
    webRef.current?.injectJavaScript(`window.__auraWrite(${JSON.stringify(b64)});true;`);
  }, []);

  useEffect(() => {
    if (!cfg || !cfg.url || !cfg.token) return;

    const client = new WsClient(cfg, {
      onStatus: setStatus,
      onBinary: (data) => {
        if (!webReadyRef.current) return;
        pendingFramesRef.current.push(new Uint8Array(data));
        if (!flushScheduledRef.current) {
          flushScheduledRef.current = true;
          // Coalesce frames that arrive in the same tick into a single
          // injectJavaScript call. The WebView bridge is the expensive step,
          // so batching here cuts per-byte overhead when the server sends
          // several small frames in quick succession (prompt repaints, etc.).
          // setTimeout(0) yields ~next-tick batching without noticeable lag.
          setTimeout(flushPending, 0);
        }
      },
    });
    clientRef.current = client;
    client.start();

    const sub = AppState.addEventListener("change", (next: AppStateStatus) => {
      if (next === "active") client.kick();
    });

    return () => {
      sub.remove();
      client.stop();
      clientRef.current = null;
      pendingFramesRef.current = [];
    };
  }, [cfg, flushPending]);

  const onWebMessage = useCallback((event: WebViewMessageEvent) => {
    const raw = event.nativeEvent.data;
    if (!raw) return;
    // Compact prefix protocol — avoid JSON.parse per keystroke.
    const prefix = raw.charCodeAt(0);
    // 'i' = input
    if (prefix === 105) {
      const bytes = base64ToBytes(raw.slice(1));
      clientRef.current?.sendInput(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      );
      return;
    }
    // 'r' = resize
    if (prefix === 114) {
      const [r, c] = raw.slice(1).split(",");
      const rows = Math.max(1, Math.floor(Number(r) || 0));
      const cols = Math.max(1, Math.floor(Number(c) || 0));
      clientRef.current?.sendControl({ type: "resize", rows, cols });
      return;
    }
    // 'R' = ready
    if (prefix === 82) {
      webReadyRef.current = true;
      webRef.current?.injectJavaScript("window.__auraFit();window.__auraFocus();true;");
      return;
    }
  }, []);

  const source = useMemo(() => ({ html: terminalHtml, baseUrl: "https://aura.local/" }), []);

  if (!cfg || !cfg.url || !cfg.token) {
    return (
      <View style={styles.emptyContainer}>
        <View style={styles.emptyCard}>
          <Text style={styles.emptyIcon}>◈</Text>
          <Text style={styles.emptyTitle}>Welcome to aura</Text>
          <Text style={styles.emptySubtitle}>
            Connect to your aura-server to attach to a persistent tmux session.
          </Text>
          <Pressable
            onPress={() => navigation.navigate("Settings")}
            style={({ pressed }) => [styles.primaryButton, pressed && styles.primaryButtonPressed]}
          >
            <Text style={styles.primaryButtonText}>Set up connection</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <WebView
        ref={webRef}
        originWhitelist={["*"]}
        source={source}
        onMessage={onWebMessage}
        javaScriptEnabled
        domStorageEnabled
        setSupportMultipleWindows={false}
        keyboardDisplayRequiresUserAction={false}
        hideKeyboardAccessoryView
        style={styles.web}
        automaticallyAdjustContentInsets={false}
        contentInsetAdjustmentBehavior="never"
        overScrollMode="never"
        androidLayerType={Platform.OS === "android" ? "hardware" : undefined}
        scrollEnabled={false}
      />
      {status !== "open" && <OfflineBanner status={status} />}
    </View>
  );
}

function HeaderTitle({ status }: { status: WsStatus }) {
  return (
    <View style={styles.headerTitleWrap}>
      <View style={[styles.statusDot, statusDotStyle(status)]} />
      <Text style={styles.headerTitleText}>aura</Text>
      <Text style={styles.headerStatusText}>{statusLabel(status)}</Text>
    </View>
  );
}

function OfflineBanner({ status }: { status: WsStatus }) {
  return (
    <View style={styles.banner} pointerEvents="none">
      {status === "connecting" ? (
        <ActivityIndicator size="small" color="#7aa2f7" />
      ) : (
        <View style={[styles.statusDot, statusDotStyle(status)]} />
      )}
      <Text style={styles.bannerText}>
        {status === "connecting" ? "Reconnecting…" : "Offline — will retry"}
      </Text>
    </View>
  );
}

function statusLabel(s: WsStatus): string {
  switch (s) {
    case "open":
      return "connected";
    case "connecting":
      return "connecting";
    case "closed":
      return "offline";
  }
}

function statusDotStyle(s: WsStatus) {
  switch (s) {
    case "open":
      return { backgroundColor: "#9ece6a", shadowColor: "#9ece6a" };
    case "connecting":
      return { backgroundColor: "#e0af68", shadowColor: "#e0af68" };
    case "closed":
      return { backgroundColor: "#f7768e", shadowColor: "#f7768e" };
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0b0b0f" },
  web: { flex: 1, backgroundColor: "#0b0b0f" },

  headerTitleWrap: { flexDirection: "row", alignItems: "center" },
  headerTitleText: {
    color: "#e4e6ef",
    fontSize: 17,
    fontWeight: "600",
    letterSpacing: 0.3,
  },
  headerStatusText: {
    color: "#6b7089",
    fontSize: 12,
    marginLeft: 8,
    textTransform: "lowercase",
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 8,
    shadowOpacity: 0.6,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 0 },
  },

  headerIconButton: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  headerIcon: { color: "#c0caf5", fontSize: 20 },

  emptyContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    backgroundColor: "#0b0b0f",
  },
  emptyCard: {
    width: "100%",
    maxWidth: 380,
    padding: 28,
    borderRadius: 20,
    backgroundColor: "#14151c",
    borderWidth: 1,
    borderColor: "#20222c",
    alignItems: "center",
  },
  emptyIcon: {
    color: "#7aa2f7",
    fontSize: 40,
    marginBottom: 16,
  },
  emptyTitle: {
    color: "#e4e6ef",
    fontSize: 22,
    fontWeight: "700",
    marginBottom: 8,
    letterSpacing: 0.2,
  },
  emptySubtitle: {
    color: "#8b90a8",
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
    marginBottom: 24,
  },
  primaryButton: {
    backgroundColor: "#7aa2f7",
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderRadius: 12,
  },
  primaryButtonPressed: { backgroundColor: "#6a8fe0" },
  primaryButtonText: {
    color: "#0b0b0f",
    fontWeight: "700",
    fontSize: 15,
    letterSpacing: 0.2,
  },

  banner: {
    position: "absolute",
    bottom: 24,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(20, 21, 28, 0.92)",
    borderWidth: 1,
    borderColor: "#2a2d3d",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
  },
  bannerText: {
    color: "#c0caf5",
    fontSize: 13,
    marginLeft: 8,
    fontWeight: "500",
  },
});
