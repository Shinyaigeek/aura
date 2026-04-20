import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  type AppStateStatus,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import type { RootStackParamList } from "../../App";
import { base64ToBytes, bytesToBase64 } from "@/lib/base64";
import { killSession } from "@/lib/kill-session";
import {
  loadConfig,
  loadTabs,
  nextTabId,
  saveTabs,
  type ServerConfig,
  type Tab,
  type TabsState,
} from "@/lib/storage";
import { subscribePushTap, usePushRegistration } from "@/lib/push";
import { terminalHtml } from "@/lib/terminal-html";
import { WsClient, type WsStatus } from "@/lib/ws";
import DirectoryBrowser from "./DirectoryBrowser";

type Props = NativeStackScreenProps<RootStackParamList, "Terminal">;

// How long a tab must be unfocused before we drop its WebSocket. The tmux
// session on the server stays alive; the user just pays a reconnect the next
// time they switch back to it. The number is a tradeoff between battery
// (fewer idle sockets) and latency-to-visible (how long the redraw takes on
// switch-back). One hour matches the user's stated intent.
const IDLE_DETACH_MS = 60 * 60 * 1000;

export default function TerminalScreen({ navigation }: Props) {
  const [cfg, setCfg] = useState<ServerConfig | null>(null);
  const [tabsState, setTabsState] = useState<TabsState | null>(null);
  const [statuses, setStatuses] = useState<Record<string, WsStatus>>({});
  const [browserOpen, setBrowserOpen] = useState(false);

  // Shared per-tab WsClient registry: TabView registers its client on mount so
  // TerminalScreen-level UI (the directory browser) can reach the active tab's
  // socket without lifting the whole TabView state up.
  const clientsRef = useRef<Record<string, WsClient>>({});
  const registerClient = useCallback((id: string, client: WsClient | null) => {
    if (client) clientsRef.current[id] = client;
    else delete clientsRef.current[id];
  }, []);

  usePushRegistration(cfg);

  // Tapping a CC completion notification should jump to the matching tab. If
  // that tab was closed in the UI (server session still alive), recreate it
  // so the user can resume.
  useEffect(() => {
    const unsub = subscribePushTap(({ sessionId }) => {
      if (!sessionId) return;
      setTabsState((prev) => {
        if (!prev) return prev;
        if (prev.tabs.some((t) => t.id === sessionId)) {
          return prev.activeTabId === sessionId ? prev : { ...prev, activeTabId: sessionId };
        }
        return {
          tabs: [...prev.tabs, { id: sessionId, label: sessionId }],
          activeTabId: sessionId,
        };
      });
    });
    return unsub;
  }, []);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      Promise.all([loadConfig(), loadTabs()]).then(([c, t]) => {
        if (cancelled) return;
        setCfg(c);
        setTabsState(t);
      });
      return () => {
        cancelled = true;
      };
    }, []),
  );

  // Persist on every mutation. Cheap — AsyncStorage write is a few KB.
  useEffect(() => {
    if (tabsState) void saveTabs(tabsState);
  }, [tabsState]);

  const activeStatus: WsStatus = tabsState
    ? (statuses[tabsState.activeTabId] ?? "closed")
    : "closed";

  useEffect(() => {
    navigation.setOptions({
      headerTitle: () => <HeaderTitle status={activeStatus} />,
      headerRight: () => (
        <View style={styles.headerRightGroup}>
          <Pressable
            onPress={() => setBrowserOpen(true)}
            hitSlop={10}
            style={({ pressed }) => [styles.headerIconButton, pressed && { opacity: 0.55 }]}
          >
            <Text style={styles.headerIcon}>▤</Text>
          </Pressable>
          <Pressable
            onPress={() => navigation.navigate("Settings")}
            hitSlop={10}
            style={({ pressed }) => [styles.headerIconButton, pressed && { opacity: 0.55 }]}
          >
            <Text style={styles.headerIcon}>⚙</Text>
          </Pressable>
        </View>
      ),
    });
  }, [navigation, activeStatus]);

  const handleStatus = useCallback((id: string, status: WsStatus) => {
    setStatuses((prev) => (prev[id] === status ? prev : { ...prev, [id]: status }));
  }, []);

  const addTab = useCallback(() => {
    setTabsState((prev) => {
      if (!prev) return prev;
      const id = nextTabId(prev.tabs);
      return {
        tabs: [...prev.tabs, { id, label: id }],
        activeTabId: id,
      };
    });
  }, []);

  const selectTab = useCallback((id: string) => {
    setTabsState((prev) => (prev && prev.activeTabId !== id ? { ...prev, activeTabId: id } : prev));
  }, []);

  const closeTab = useCallback(
    (id: string) => {
      const runClose = () => {
        setTabsState((prev) => {
          if (!prev) return prev;
          const remaining = prev.tabs.filter((t) => t.id !== id);
          if (remaining.length === 0) {
            // Keep at least one tab around so the UI has something to show.
            const fresh = nextTabId([]);
            return { tabs: [{ id: fresh, label: fresh }], activeTabId: fresh };
          }
          const activeTabId =
            prev.activeTabId === id ? remaining[remaining.length - 1].id : prev.activeTabId;
          return { tabs: remaining, activeTabId };
        });
        setStatuses((prev) => {
          if (!(id in prev)) return prev;
          const { [id]: _dropped, ...rest } = prev;
          return rest;
        });
        if (cfg?.url && cfg?.token) {
          void killSession(cfg, id).catch((err) => {
            console.warn("killSession failed", err);
          });
        }
      };

      Alert.alert(
        "Close tab?",
        `This terminates the tmux session "${id}" on the server. Running processes will be killed.`,
        [
          { text: "Cancel", style: "cancel" },
          { text: "Close", style: "destructive", onPress: runClose },
        ],
      );
    },
    [cfg],
  );

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

  if (!tabsState) return <View style={styles.container} />;

  return (
    <View style={styles.container}>
      <TabBar
        tabs={tabsState.tabs}
        activeTabId={tabsState.activeTabId}
        statuses={statuses}
        onSelect={selectTab}
        onClose={closeTab}
        onAdd={addTab}
      />
      <View style={styles.terminalWrap}>
        {tabsState.tabs.map((tab) => (
          <TabView
            key={tab.id}
            cfg={cfg}
            tab={tab}
            active={tab.id === tabsState.activeTabId}
            onStatus={handleStatus}
            registerClient={registerClient}
          />
        ))}
      </View>
      {activeStatus !== "open" && <OfflineBanner status={activeStatus} />}

      <Modal
        visible={browserOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setBrowserOpen(false)}
      >
        <DirectoryBrowser
          client={clientsRef.current[tabsState.activeTabId] ?? null}
          onClose={() => setBrowserOpen(false)}
          onPick={(path) => {
            const client = clientsRef.current[tabsState.activeTabId];
            if (client) client.sendInput(`cd ${shellQuote(path)}\r`);
            setBrowserOpen(false);
          }}
        />
      </Modal>
    </View>
  );
}

// POSIX single-quote shell quoting. Single quotes cannot appear inside single
// quotes, so split on them: `'...'\''...'`.
function shellQuote(s: string): string {
  return "'" + s.replaceAll("'", "'\\''") + "'";
}

type TabViewProps = {
  cfg: ServerConfig;
  tab: Tab;
  active: boolean;
  onStatus: (id: string, status: WsStatus) => void;
  registerClient: (id: string, client: WsClient | null) => void;
};

// One tab = one WebSocket + one WebView (with its own xterm.js instance).
// Non-active tabs stay mounted with `display:none` so their scrollback and
// xterm buffer survive tab switches. The WebSocket, in contrast, is dropped
// after IDLE_DETACH_MS of being non-active — the server's tmux session keeps
// running regardless.
function TabView({ cfg, tab, active, onStatus, registerClient }: TabViewProps) {
  const webRef = useRef<WebView | null>(null);
  const clientRef = useRef<WsClient | null>(null);
  const webReadyRef = useRef(false);
  const pendingFramesRef = useRef<Uint8Array[]>([]);
  const flushScheduledRef = useRef(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // Own the WsClient for this tab's lifetime. Creation runs when cfg or tab.id
  // change; the active-state effect below decides when to actually connect.
  useEffect(() => {
    const client = new WsClient(cfg, tab.id, {
      onStatus: (s) => onStatus(tab.id, s),
      onBinary: (data) => {
        if (!webReadyRef.current) return;
        pendingFramesRef.current.push(new Uint8Array(data));
        if (!flushScheduledRef.current) {
          flushScheduledRef.current = true;
          setTimeout(flushPending, 0);
        }
      },
    });
    clientRef.current = client;
    registerClient(tab.id, client);

    return () => {
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      client.stop();
      registerClient(tab.id, null);
      clientRef.current = null;
      pendingFramesRef.current = [];
      webReadyRef.current = false;
    };
  }, [cfg, tab.id, onStatus, flushPending, registerClient]);

  // React to active-state changes. Becoming active clears the idle timer and
  // kicks a reconnect if needed; becoming inactive starts the countdown.
  useEffect(() => {
    const client = clientRef.current;
    if (!client) return;
    if (active) {
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      client.kick();
      if (webReadyRef.current) {
        // Re-fit in case viewport dimensions changed while hidden (keyboard,
        // rotation), and refocus so keystrokes land immediately. The retry
        // covers the race where the first focus fires before the native
        // WebView has regained focus after the tab became visible.
        webRef.current?.injectJavaScript("window.__auraFit();window.__auraFocus();true;");
        const retry = setTimeout(() => {
          webRef.current?.injectJavaScript("window.__auraFocus();true;");
        }, 120);
        return () => clearTimeout(retry);
      }
    } else {
      // Release focus so the OS keyboard detaches from this WebView's hidden
      // textarea before the tab goes offscreen; otherwise iOS keeps routing
      // IME composition into it, which paints over the now-visible tab.
      if (webReadyRef.current) {
        webRef.current?.injectJavaScript("window.__auraBlur();true;");
      }
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(() => {
        idleTimerRef.current = null;
        clientRef.current?.stop();
      }, IDLE_DETACH_MS);
    }
  }, [active]);

  // Foreground reconnect: only the currently-active tab gets auto-kicked.
  // Hidden tabs wait until the user visits them — no point racing N sockets
  // through a flaky first-minute-after-resume window.
  useEffect(() => {
    if (!active) return;
    const sub = AppState.addEventListener("change", (next: AppStateStatus) => {
      if (next === "active") clientRef.current?.kick();
    });
    return () => sub.remove();
  }, [active]);

  const onWebMessage = useCallback((event: WebViewMessageEvent) => {
    const raw = event.nativeEvent.data;
    if (!raw) return;
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

  return (
    <View
      style={[styles.tabView, !active && styles.tabViewHidden]}
      pointerEvents={active ? "auto" : "none"}
    >
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
    </View>
  );
}

type TabBarProps = {
  tabs: readonly Tab[];
  activeTabId: string;
  statuses: Record<string, WsStatus>;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onAdd: () => void;
};

function TabBar({ tabs, activeTabId, statuses, onSelect, onClose, onAdd }: TabBarProps) {
  return (
    <View style={styles.tabBar}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.tabBarContent}
        keyboardShouldPersistTaps="handled"
      >
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          const status = statuses[tab.id] ?? "closed";
          return (
            <Pressable
              key={tab.id}
              onPress={() => onSelect(tab.id)}
              style={({ pressed }) => [
                styles.tabPill,
                isActive && styles.tabPillActive,
                pressed && { opacity: 0.7 },
              ]}
            >
              <View style={[styles.statusDot, statusDotStyle(status), styles.tabPillDot]} />
              <Text
                style={[styles.tabPillText, isActive && styles.tabPillTextActive]}
                numberOfLines={1}
              >
                {tab.label}
              </Text>
              <Pressable
                onPress={() => onClose(tab.id)}
                hitSlop={8}
                style={({ pressed }) => [styles.tabCloseButton, pressed && { opacity: 0.5 }]}
              >
                <Text style={styles.tabCloseText}>×</Text>
              </Pressable>
            </Pressable>
          );
        })}
        <Pressable
          onPress={onAdd}
          style={({ pressed }) => [styles.tabAddButton, pressed && { opacity: 0.6 }]}
          hitSlop={6}
        >
          <Text style={styles.tabAddText}>+</Text>
        </Pressable>
      </ScrollView>
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
  terminalWrap: { flex: 1, position: "relative" },
  tabView: { ...StyleSheet.absoluteFillObject },
  // Hide with opacity rather than display:none so the native WebView stays
  // laid out and keeps its focus plumbing intact across tab switches. Touches
  // are already gated via pointerEvents on the wrapping View.
  tabViewHidden: { opacity: 0 },
  web: { flex: 1, backgroundColor: "#0b0b0f" },

  tabBar: {
    backgroundColor: "#0b0b0f",
    borderBottomWidth: 1,
    borderBottomColor: "#1a1c26",
  },
  tabBarContent: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    alignItems: "center",
  },
  tabPill: {
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 10,
    paddingRight: 4,
    paddingVertical: 6,
    marginRight: 6,
    borderRadius: 999,
    backgroundColor: "#14151c",
    borderWidth: 1,
    borderColor: "#20222c",
    maxWidth: 180,
  },
  tabPillActive: {
    backgroundColor: "#1c2030",
    borderColor: "#3b4262",
  },
  tabPillDot: { marginRight: 6 },
  tabPillText: {
    color: "#8b90a8",
    fontSize: 13,
    fontWeight: "500",
    letterSpacing: 0.2,
    maxWidth: 120,
  },
  tabPillTextActive: { color: "#e4e6ef" },
  tabCloseButton: {
    marginLeft: 6,
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  tabCloseText: {
    color: "#6b7089",
    fontSize: 16,
    lineHeight: 18,
    fontWeight: "600",
  },
  tabAddButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "#14151c",
    borderWidth: 1,
    borderColor: "#20222c",
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 2,
  },
  tabAddText: {
    color: "#c0caf5",
    fontSize: 18,
    fontWeight: "600",
    lineHeight: 20,
  },

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

  headerRightGroup: { flexDirection: "row", alignItems: "center" },
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
