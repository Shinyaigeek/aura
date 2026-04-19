import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, type AppStateStatus, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import type { RootStackParamList } from "../../App";
import { base64ToBytes, bytesToBase64 } from "@/lib/base64";
import { loadConfig, type ServerConfig } from "@/lib/storage";
import { terminalHtml } from "@/lib/terminal-html";
import { WsClient, type WsStatus } from "@/lib/ws";

type Props = NativeStackScreenProps<RootStackParamList, "Terminal">;

type WebMessage =
  | { kind: "ready" }
  | { kind: "input"; data: string }
  | { kind: "resize"; rows: number; cols: number };

export default function TerminalScreen({ navigation }: Props) {
  const [cfg, setCfg] = useState<ServerConfig | null>(null);
  const [status, setStatus] = useState<WsStatus>("closed");
  const webRef = useRef<WebView | null>(null);
  const clientRef = useRef<WsClient | null>(null);
  const webReadyRef = useRef(false);

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
      headerRight: () => (
        <TouchableOpacity onPress={() => navigation.navigate("Settings")}>
          <Text style={styles.headerButton}>Settings</Text>
        </TouchableOpacity>
      ),
      title: statusLabel(status),
    });
  }, [navigation, status]);

  useEffect(() => {
    if (!cfg || !cfg.url || !cfg.token) return;

    const client = new WsClient(cfg, {
      onStatus: setStatus,
      onBinary: (data) => {
        if (!webReadyRef.current) return;
        const b64 = bytesToBase64(new Uint8Array(data));
        webRef.current?.injectJavaScript(
          `window.__auraWrite(${JSON.stringify(b64)}); true;`,
        );
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
    };
  }, [cfg]);

  const onWebMessage = useCallback((event: WebViewMessageEvent) => {
    let msg: WebMessage;
    try {
      msg = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    switch (msg.kind) {
      case "ready":
        webReadyRef.current = true;
        webRef.current?.injectJavaScript("window.__auraFit(); window.__auraFocus(); true;");
        break;
      case "input":
        clientRef.current?.sendInput(base64ToBytes(msg.data).buffer);
        break;
      case "resize":
        clientRef.current?.sendControl({
          type: "resize",
          rows: Math.max(1, Math.floor(msg.rows)),
          cols: Math.max(1, Math.floor(msg.cols)),
        });
        break;
    }
  }, []);

  const source = useMemo(() => ({ html: terminalHtml, baseUrl: "https://aura.local/" }), []);

  if (!cfg || !cfg.url || !cfg.token) {
    return (
      <View style={styles.centered}>
        <Text style={styles.placeholderText}>
          Set the server URL and token in Settings to get started.
        </Text>
        <TouchableOpacity
          style={styles.primaryButton}
          onPress={() => navigation.navigate("Settings")}
        >
          <Text style={styles.primaryButtonText}>Open Settings</Text>
        </TouchableOpacity>
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
      />
    </View>
  );
}

function statusLabel(s: WsStatus): string {
  switch (s) {
    case "open":
      return "aura · connected";
    case "connecting":
      return "aura · connecting…";
    case "closed":
      return "aura · offline";
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0b0b0b" },
  web: { flex: 1, backgroundColor: "#0b0b0b" },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    backgroundColor: "#0b0b0b",
  },
  placeholderText: {
    color: "#cfcfcf",
    fontSize: 16,
    textAlign: "center",
    marginBottom: 24,
  },
  primaryButton: {
    backgroundColor: "#3a6df0",
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 8,
  },
  primaryButtonText: { color: "white", fontWeight: "600" },
  headerButton: { color: "#e5e5e5", fontSize: 15, paddingHorizontal: 8 },
});
