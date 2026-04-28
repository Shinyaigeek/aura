import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useFocusEffect } from "@react-navigation/native";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { useSessionMetaMap, type SessionMeta } from "@/lib/session-meta";
import { terminalHtml } from "@/lib/terminal-html";
import { uploadFile, type UploadProgress } from "@/lib/upload";
import { WsClient, type WsStatus } from "@/lib/ws";
import DirectoryBrowser from "./DirectoryBrowser";

type PickedFile = {
  uri: string;
  name: string;
  mimeType?: string;
  size?: number;
};

type Props = NativeStackScreenProps<RootStackParamList, "Terminal">;

// How long a tab must be unfocused before we drop its WebSocket. The tmux
// session on the server stays alive; the user just pays a reconnect the next
// time they switch back to it. The number is a tradeoff between battery
// (fewer idle sockets) and latency-to-visible (how long the redraw takes on
// switch-back). One hour matches the user's stated intent.
const IDLE_DETACH_MS = 60 * 60 * 1000;

// Module-scope counter that survives TerminalScreen unmount/remount cycles.
// useState's initialiser runs once per component instance, so each fresh
// mount of TerminalScreen reads + increments this and gets a higher id.
// Surfaced in the overlay as `S:<id>` — if M:5 came with S:5 then the whole
// screen is remounting (likely react-navigation churn); if M:5 came with
// S:1 then TabView alone is bouncing inside a stable TerminalScreen.
let _screenInstanceCounter = 0;

export default function TerminalScreen({ navigation }: Props) {
  const [screenInstance] = useState<number>(() => {
    _screenInstanceCounter += 1;
    return _screenInstanceCounter;
  });
  const [cfg, setCfg] = useState<ServerConfig | null>(null);
  const [tabsState, setTabsState] = useState<TabsState | null>(null);
  const [statuses, setStatuses] = useState<Record<string, WsStatus>>({});
  const [browserOpen, setBrowserOpen] = useState(false);
  const [pendingUpload, setPendingUpload] = useState<PickedFile | null>(null);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [copyText, setCopyText] = useState<string | null>(null);
  // Diagnostic state for the cold-start "connected, black, no input" bug.
  // The active TabView reports phase markers, byte counts, and tap counts
  // here; DebugOverlay paints a one-line summary on top of the screen so we
  // can tell on the device whether xterm even initialised, whether bytes
  // are reaching it, and whether taps reach the WebView at all.
  const [dbgLast, setDbgLast] = useState<string>("");
  const [dbgBytes, setDbgBytes] = useState<number>(0);
  const [dbgTaps, setDbgTaps] = useState<number>(0);
  const [dbgReady, setDbgReady] = useState<boolean>(false);
  // Mount/unmount counters live as their own state fields so they survive
  // the trail's 140-char truncation. v0.0.15 logged tabview-mount into the
  // trail but the rapid bcl/loadstart loop pushed it out of the window
  // before the user could read it.
  const [dbgMounts, setDbgMounts] = useState<number>(0);
  const [dbgUnmounts, setDbgUnmounts] = useState<number>(0);
  // ER counts how many times TerminalScreen entered an early-return branch
  // (cfg invalid OR tabsState null). If TabView is remounting because the
  // parent flips between "render TabView" and "render empty state", this
  // climbs in lock-step with M. R counts TerminalScreen renders, flushed at
  // 1 Hz from a ref so display itself doesn't add re-render pressure.
  const [dbgEarlyEntries, setDbgEarlyEntries] = useState<number>(0);
  const [dbgRenders, setDbgRenders] = useState<number>(0);
  const dbgRendersRef = useRef(0);
  dbgRendersRef.current += 1;
  const dbgLastBranchRef = useRef<string>("init");
  // Bytes/taps go through refs first and are flushed to state on a 1Hz
  // interval. v0.0.13 routed them straight into setState on every event,
  // which on a chatty session (tmux status bar emits bytes constantly)
  // turned into hundreds of state updates per second. Each re-render
  // passed new inline-arrow callbacks to <WebView>; react-native-webview
  // 13.x apparently treats that as enough of a prop change to recycle
  // the underlying WebView, which is why the v0.0.13 trail showed
  // bcl/loadstart/loadend repeating without ever reaching script-start.
  const dbgBytesRef = useRef(0);
  const dbgTapsRef = useRef(0);
  const onDbg = useCallback((line: string) => {
    setDbgLast((prev) => {
      // Accumulate the trail so the overlay shows the sequence, not just
      // the most recent marker. Cap so the line stays readable on a phone.
      const next = prev ? `${prev} > ${line}` : line;
      return next.length > 140 ? `…${next.slice(-139)}` : next;
    });
    if (line === "R-sent") setDbgReady(true);
  }, []);
  const onDbgBytes = useCallback((n: number) => {
    dbgBytesRef.current += n;
  }, []);
  const onDbgTap = useCallback(() => {
    dbgTapsRef.current += 1;
  }, []);
  const onDbgMount = useCallback(() => {
    setDbgMounts((prev) => prev + 1);
  }, []);
  const onDbgUnmount = useCallback(() => {
    setDbgUnmounts((prev) => prev + 1);
  }, []);
  useEffect(() => {
    const id = setInterval(() => {
      setDbgBytes((prev) => (prev === dbgBytesRef.current ? prev : dbgBytesRef.current));
      setDbgTaps((prev) => (prev === dbgTapsRef.current ? prev : dbgTapsRef.current));
      setDbgRenders((prev) => (prev === dbgRendersRef.current ? prev : dbgRendersRef.current));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // Shared per-tab WsClient registry: TabView registers its client on mount so
  // TerminalScreen-level UI (the directory browser) can reach the active tab's
  // socket without lifting the whole TabView state up.
  const clientsRef = useRef<Record<string, WsClient>>({});
  const registerClient = useCallback((id: string, client: WsClient | null) => {
    if (client) clientsRef.current[id] = client;
    else delete clientsRef.current[id];
  }, []);

  // Parallel registry for WebView refs so the header can invoke
  // __auraDumpBuffer on the active tab's WebView.
  const websRef = useRef<Record<string, WebView>>({});
  const registerWeb = useCallback((id: string, web: WebView | null) => {
    if (web) websRef.current[id] = web;
    else delete websRef.current[id];
  }, []);

  // activeTabIdRef shadows tabsState.activeTabId so header callbacks (copy,
  // upload) can stay referentially stable — otherwise `useCallback([tabsState])`
  // churns on every status/tab/meta update, thrashing navigation.setOptions
  // and, on Android native-stack, causing header/WebView re-attach storms that
  // presented as "offline" or a black terminal even when connected.
  const activeTabIdRef = useRef<string | null>(null);
  activeTabIdRef.current = tabsState?.activeTabId ?? null;

  const handleBufferDump = useCallback((text: string) => {
    setCopyText(text);
  }, []);

  usePushRegistration(cfg);

  const tabIds = useMemo(() => tabsState?.tabs.map((t) => t.id) ?? [], [tabsState]);
  const metaMap = useSessionMetaMap(cfg, tabIds);

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

  // Watch for the early-return branches that yank TabView out of the tree.
  // Effects run after every committed render, so we can compare the branch
  // we just rendered to the previous one and count transitions into the
  // "early" branch. If E climbs lock-step with M, the cause is found.
  useEffect(() => {
    const inEarly = !cfg || !cfg.url || !cfg.token || !tabsState;
    const branch = inEarly ? "early" : "full";
    if (branch === "early" && dbgLastBranchRef.current !== "early") {
      setDbgEarlyEntries((prev) => prev + 1);
    }
    dbgLastBranchRef.current = branch;
  });

  const activeStatus: WsStatus = tabsState
    ? (statuses[tabsState.activeTabId] ?? "closed")
    : "closed";

  const onCopyPress = useCallback(() => {
    const id = activeTabIdRef.current;
    if (!id) return;
    const web = websRef.current[id];
    if (!web) return;
    web.injectJavaScript("window.__auraDumpBuffer&&window.__auraDumpBuffer();true;");
  }, []);

  const onEscPress = useCallback(() => {
    const id = activeTabIdRef.current;
    if (!id) return;
    clientsRef.current[id]?.sendInput("\x1b");
    // Tapping a header button steals focus from the WebView's hidden textarea
    // and dismisses the soft keyboard. Re-focus so the user can keep typing
    // the next thing Claude prompts for without re-tapping the terminal.
    websRef.current[id]?.injectJavaScript("window.__auraFocus&&window.__auraFocus();true;");
  }, []);

  const onUploadPress = useCallback(() => {
    const handlePick = (p: Promise<PickedFile | null>) => {
      p.then(setPendingUpload).catch((err: unknown) => {
        Alert.alert("Could not pick file", err instanceof Error ? err.message : String(err));
      });
    };
    Alert.alert("Send to server", "Choose a source", [
      { text: "Photo", onPress: () => handlePick(pickFromPhotos()) },
      { text: "File", onPress: () => handlePick(pickDocument()) },
      { text: "Cancel", style: "cancel" },
    ]);
  }, []);

  useEffect(() => {
    navigation.setOptions({
      headerTitle: () => <HeaderTitle status={activeStatus} />,
      headerRight: () => (
        <View style={styles.headerRightGroup}>
          <Pressable
            onPress={onEscPress}
            hitSlop={10}
            style={({ pressed }) => [styles.headerIconButton, pressed && { opacity: 0.55 }]}
          >
            <Text style={styles.headerEscText}>ESC</Text>
          </Pressable>
          <Pressable
            onPress={onCopyPress}
            hitSlop={10}
            style={({ pressed }) => [styles.headerIconButton, pressed && { opacity: 0.55 }]}
          >
            <Text style={styles.headerIcon}>⧉</Text>
          </Pressable>
          <Pressable
            onPress={onUploadPress}
            hitSlop={10}
            style={({ pressed }) => [styles.headerIconButton, pressed && { opacity: 0.55 }]}
          >
            <Text style={styles.headerIcon}>⇪</Text>
          </Pressable>
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
  }, [navigation, activeStatus, onCopyPress, onUploadPress, onEscPress]);
  // onCopyPress / onUploadPress / onEscPress are ref-stable now; they're listed
  // so the lint rule stays happy but their identities never change.

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
        metaMap={metaMap}
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
            registerWeb={registerWeb}
            onBuffer={handleBufferDump}
            onDbg={onDbg}
            onDbgBytes={onDbgBytes}
            onDbgTap={onDbgTap}
            onDbgMount={onDbgMount}
            onDbgUnmount={onDbgUnmount}
          />
        ))}
      </View>
      {activeStatus !== "open" && <OfflineBanner status={activeStatus} />}
      <DebugOverlay
        status={activeStatus}
        ready={dbgReady}
        bytes={dbgBytes}
        taps={dbgTaps}
        mounts={dbgMounts}
        unmounts={dbgUnmounts}
        earlyEntries={dbgEarlyEntries}
        renders={dbgRenders}
        screenInstance={screenInstance}
        last={dbgLast}
      />

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

      <Modal
        visible={pendingUpload !== null}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setPendingUpload(null)}
      >
        {pendingUpload && (
          <DirectoryBrowser
            client={clientsRef.current[tabsState.activeTabId] ?? null}
            title={`Upload ${pendingUpload.name}`}
            primaryLabel="Upload here"
            onClose={() => setPendingUpload(null)}
            onPick={(dest) => {
              const file = pendingUpload;
              setPendingUpload(null);
              void runUpload({
                cfg,
                sessionId: tabsState.activeTabId,
                file,
                dest,
                onProgress: setUploadProgress,
                onInsertPath: (path) => {
                  const client = clientsRef.current[tabsState.activeTabId];
                  if (client) client.sendInput(`${shellQuote(path)} `);
                },
              }).finally(() => setUploadProgress(null));
            }}
          />
        )}
      </Modal>

      {uploadProgress && <UploadOverlay progress={uploadProgress} />}

      <Modal
        visible={copyText !== null}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setCopyText(null)}
      >
        <CopyModal text={copyText ?? ""} onClose={() => setCopyText(null)} />
      </Modal>
    </View>
  );
}

function CopyModal({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <View style={styles.copyModalContainer}>
      <View style={styles.copyModalHeader}>
        <Text style={styles.copyModalTitle}>Select & copy</Text>
        <Pressable onPress={onClose} hitSlop={10}>
          <Text style={styles.copyModalDone}>Done</Text>
        </Pressable>
      </View>
      <ScrollView
        style={styles.copyModalScroll}
        contentContainerStyle={styles.copyModalScrollContent}
      >
        <Text selectable style={styles.copyModalText}>
          {text.length > 0 ? text : "(buffer is empty)"}
        </Text>
      </ScrollView>
    </View>
  );
}

type RunUploadArgs = {
  cfg: ServerConfig;
  sessionId: string;
  file: PickedFile;
  dest: string;
  onProgress: (p: UploadProgress | null) => void;
  onInsertPath: (path: string) => void;
};

async function runUpload(args: RunUploadArgs): Promise<void> {
  args.onProgress({ sent: 0, total: args.file.size ?? 0 });
  try {
    const result = await uploadFile(args.cfg, args.sessionId, args.file.uri, {
      filename: args.file.name,
      dest: args.dest,
      mimeType: args.file.mimeType,
      onProgress: (p) => args.onProgress(p),
    });
    Alert.alert(
      "Upload complete",
      result.path,
      [
        { text: "OK", style: "cancel" },
        {
          text: "Insert path",
          onPress: () => args.onInsertPath(result.path),
        },
      ],
      { cancelable: true },
    );
  } catch (e) {
    Alert.alert("Upload failed", e instanceof Error ? e.message : String(e));
  }
}

async function pickFromPhotos(): Promise<PickedFile | null> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) {
    Alert.alert("Permission denied", "Photo library access is required.");
    return null;
  }
  const res = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    allowsMultipleSelection: false,
    quality: 1,
    exif: false,
    base64: false,
  });
  if (res.canceled || res.assets.length === 0) return null;
  const a = res.assets[0];
  return {
    uri: a.uri,
    name: a.fileName || deriveName(a.uri, a.mimeType),
    mimeType: a.mimeType,
    size: a.fileSize,
  };
}

async function pickDocument(): Promise<PickedFile | null> {
  const res = await DocumentPicker.getDocumentAsync({
    copyToCacheDirectory: true,
    multiple: false,
    type: "*/*",
  });
  if (res.canceled || res.assets.length === 0) return null;
  const a = res.assets[0];
  return {
    uri: a.uri,
    name: a.name,
    mimeType: a.mimeType,
    size: a.size,
  };
}

// deriveName invents a filename for a picked image that the OS didn't name
// for us. We keep the extension from the mime type so the server-side
// `.jpg` / `.png` stays informative.
function deriveName(uri: string, mimeType?: string): string {
  const extFromMime = mimeType?.split("/")[1]?.replace("jpeg", "jpg");
  const ext = extFromMime || uri.split(".").pop() || "bin";
  return `photo-${Date.now()}.${ext}`;
}

function UploadOverlay({ progress }: { progress: UploadProgress }) {
  const pct =
    progress.total > 0 ? Math.min(100, Math.round((progress.sent / progress.total) * 100)) : null;
  return (
    <View pointerEvents="auto" style={styles.overlay}>
      <View style={styles.overlayCard}>
        <ActivityIndicator color="#7aa2f7" />
        <Text style={styles.overlayText}>Uploading… {pct !== null ? `${pct}%` : "…"}</Text>
      </View>
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
  registerWeb: (id: string, web: WebView | null) => void;
  onBuffer: (text: string) => void;
  onDbg: (line: string) => void;
  onDbgBytes: (count: number) => void;
  onDbgTap: () => void;
  onDbgMount: () => void;
  onDbgUnmount: () => void;
};

// One tab = one WebSocket + one WebView (with its own xterm.js instance).
// Non-active tabs stay mounted with `display:none` so their scrollback and
// xterm buffer survive tab switches. The WebSocket, in contrast, is dropped
// after IDLE_DETACH_MS of being non-active — the server's tmux session keeps
// running regardless.
const TabView = memo(TabViewImpl);

function TabViewImpl({
  cfg,
  tab,
  active,
  onStatus,
  registerClient,
  registerWeb,
  onBuffer,
  onDbg,
  onDbgBytes,
  onDbgTap,
  onDbgMount,
  onDbgUnmount,
}: TabViewProps) {
  // Diagnostic: bump dedicated mount / unmount counters in the parent.
  // Putting these in their own state fields (instead of the trail) means
  // they survive past the trail's 140-char truncation, so the user can
  // tell at a glance whether TabView is remounting in a loop without
  // having to read a long string.
  useEffect(() => {
    onDbgMount();
    return () => onDbgUnmount();
    // Stable callbacks; we want exactly one call per real mount/unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const webRef = useRef<WebView | null>(null);
  const clientRef = useRef<WsClient | null>(null);
  const webReadyRef = useRef(false);
  const pendingFramesRef = useRef<Uint8Array[]>([]);
  const flushScheduledRef = useRef(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirror `active` into a ref so the client-creation effect can kick a freshly
  // built client without taking `active` as a dep (which would tear the client
  // down every time the tab toggled).
  const activeRef = useRef(active);
  activeRef.current = active;

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
  // change; we kick() immediately if the tab is already active so a focus-time
  // cfg re-load (which always hands us a fresh object reference, even when its
  // url/token are identical) doesn't leave us with a freshly-built client that
  // nobody ever started — that was the "offline but nothing I can do" and
  // "connected-but-black" state users saw after upgrading.
  useEffect(() => {
    const client = new WsClient(cfg, tab.id, {
      onStatus: (s) => onStatus(tab.id, s),
      onBinary: (data) => {
        // Always buffer. Flushing is gated on webReadyRef so we don't call
        // window.__auraWrite before xterm is mounted, but we must NOT drop
        // the frame: tmux's reattach redraw arrives once and never repeats.
        // The 'R' handler below kicks a flush as soon as the WebView is up.
        pendingFramesRef.current.push(new Uint8Array(data));
        onDbgBytes(data.byteLength);
        if (!webReadyRef.current) return;
        if (!flushScheduledRef.current) {
          flushScheduledRef.current = true;
          setTimeout(flushPending, 0);
        }
      },
    });
    clientRef.current = client;
    registerClient(tab.id, client);
    if (activeRef.current) client.kick();

    return () => {
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      client.stop();
      registerClient(tab.id, null);
      clientRef.current = null;
      pendingFramesRef.current = [];
      // Don't reset webReadyRef: the WebView itself is not unmounting (its
      // source is memoized [] and the TabView key is tab.id), so it won't
      // re-fire 'R'. Resetting here previously froze the ref at false on
      // every focus-driven cfg refresh, causing onBinary to drop every
      // frame and presenting as "connected but black + no input".
    };
  }, [cfg, tab.id, onStatus, flushPending, registerClient, onDbgBytes]);

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

  const onWebMessage = useCallback(
    (event: WebViewMessageEvent) => {
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
        // Drain any frames that arrived while xterm was still loading. On
        // cold start the WS often opens before the WebView finishes pulling
        // the xterm CDN bundles, so the initial tmux redraw lands here.
        if (pendingFramesRef.current.length > 0 && !flushScheduledRef.current) {
          flushScheduledRef.current = true;
          setTimeout(flushPending, 0);
        }
        return;
      }
      // 'D' = diagnostic phase marker from the WebView IIFE
      if (prefix === 68) {
        onDbg(raw.slice(1));
        return;
      }
      // 'B' = buffer dump response (utf-8 base64)
      if (prefix === 66) {
        const payload = raw.slice(1);
        if (payload.length === 0) {
          onBuffer("");
          return;
        }
        try {
          const bytes = base64ToBytes(payload);
          const text = new TextDecoder().decode(bytes);
          onBuffer(text);
        } catch {
          onBuffer("");
        }
        return;
      }
    },
    [onBuffer, flushPending, onDbg],
  );

  const source = useMemo(() => ({ html: terminalHtml, baseUrl: "https://aura.local/" }), []);

  // Publish this tab's WebView into the shared registry (used by the header
  // copy button). Using a post-mount effect + direct ref object mirrors the
  // v0.0.6 attachment shape exactly; switching to a callback ref in 0.0.7 had
  // the WebView briefly detach/reattach during re-renders on Android.
  useEffect(() => {
    registerWeb(tab.id, webRef.current);
    return () => registerWeb(tab.id, null);
  }, [registerWeb, tab.id]);

  // Stabilise every callback we hand to <WebView>. v0.0.13 used inline
  // arrows here; on a chatty session that pushed enough re-renders to
  // make react-native-webview 13.x recycle the native WebView each time,
  // looping forever on bcl→loadstart→loadend without the inline IIFE
  // ever getting a chance to finish.
  const onTouchEnd = useCallback(() => {
    onDbgTap();
    webRef.current?.injectJavaScript("window.__auraFocus&&window.__auraFocus();true;");
  }, [onDbgTap]);
  const onWvLoadStart = useCallback(() => onDbg("wv:loadstart"), [onDbg]);
  const onWvLoadEnd = useCallback(() => onDbg("wv:loadend"), [onDbg]);
  const onWvError = useCallback(
    (e: { nativeEvent: { code?: number; description?: string } }) =>
      onDbg(`wv:err:${e.nativeEvent.code ?? "?"}:${e.nativeEvent.description ?? ""}`),
    [onDbg],
  );
  const onWvHttpError = useCallback(
    (e: { nativeEvent: { statusCode: number } }) => onDbg(`wv:http:${e.nativeEvent.statusCode}`),
    [onDbg],
  );
  const onWvRenderProcessGone = useCallback(
    (e: { nativeEvent: { didCrash?: boolean } }) =>
      onDbg(`wv:rpg:${e.nativeEvent.didCrash ? "crash" : "killed"}`),
    [onDbg],
  );
  const injectedBcl = useMemo(
    () =>
      "(function(){try{var p=window.ReactNativeWebView&&window.ReactNativeWebView.postMessage;p&&p.call(window.ReactNativeWebView,'Dbcl');}catch(e){}})();true;",
    [],
  );
  // Inline `[styles.tabView, !active && ...]` allocates a fresh array on
  // every render. RN normalises style arrays for the bridge, but on new
  // arch + react-native-webview this can still translate to "the wrapping
  // View is updated" which on Android can recycle children — including
  // the WebView. Lock the reference per `active` value so the wrapping
  // View only reconciles when active actually changes.
  const wrapperStyle = useMemo(
    () => (active ? styles.tabView : [styles.tabView, styles.tabViewHidden]),
    [active],
  );

  return (
    <View style={wrapperStyle} pointerEvents={active ? "auto" : "none"} onTouchEnd={onTouchEnd}>
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
        webviewDebuggingEnabled
        onLoadStart={onWvLoadStart}
        onLoadEnd={onWvLoadEnd}
        onError={onWvError}
        onHttpError={onWvHttpError}
        onRenderProcessGone={onWvRenderProcessGone}
        injectedJavaScriptBeforeContentLoaded={injectedBcl}
      />
    </View>
  );
}

type TabBarProps = {
  tabs: readonly Tab[];
  activeTabId: string;
  statuses: Record<string, WsStatus>;
  metaMap: Record<string, SessionMeta>;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onAdd: () => void;
};

function TabBar({ tabs, activeTabId, statuses, metaMap, onSelect, onClose, onAdd }: TabBarProps) {
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
          const title = metaMap[tab.id]?.title?.trim();
          const label = title && title.length > 0 ? title : tab.label;
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
                {label}
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

// One-line diagnostic overlay pinned to the top of the terminal area while
// we chase the "connected, black, no input" symptom. Fields:
//   ws    : WebSocket status
//   R     : has the WebView IIFE fired the post('R') handshake yet?
//   B     : total bytes received from the server since mount (incl. ones
//           buffered before R)
//   T     : taps the wrapping View has seen (counted via onTouchEnd, which
//           does NOT claim the responder, so the WebView/xterm still get
//           the touch — this is purely a "did the tap reach RN at all"
//           probe)
//   last  : most recent 'D<text>' the IIFE posted, including any error
function DebugOverlay({
  status,
  ready,
  bytes,
  taps,
  mounts,
  unmounts,
  earlyEntries,
  renders,
  screenInstance,
  last,
}: {
  status: WsStatus;
  ready: boolean;
  bytes: number;
  taps: number;
  mounts: number;
  unmounts: number;
  earlyEntries: number;
  renders: number;
  screenInstance: number;
  last: string;
}) {
  const summary = `ws:${status} R:${ready ? "Y" : "N"} B:${bytes} T:${taps} M:${mounts} U:${unmounts} E:${earlyEntries} Re:${renders} S:${screenInstance}`;
  return (
    <View style={styles.dbgOverlay} pointerEvents="none">
      <Text style={styles.dbgText} numberOfLines={1}>
        {summary}
      </Text>
      <Text style={styles.dbgText} numberOfLines={2}>
        {last || "(no D yet)"}
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
  headerEscText: {
    color: "#c0caf5",
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 0.5,
  },

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

  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(11, 11, 15, 0.7)",
    alignItems: "center",
    justifyContent: "center",
  },
  overlayCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#14151c",
    borderWidth: 1,
    borderColor: "#2a2d3d",
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderRadius: 14,
  },
  overlayText: {
    color: "#e4e6ef",
    fontSize: 14,
    marginLeft: 12,
    fontWeight: "500",
  },

  copyModalContainer: {
    flex: 1,
    backgroundColor: "#0b0b0f",
  },
  copyModalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#1a1c26",
  },
  copyModalTitle: {
    color: "#e4e6ef",
    fontSize: 16,
    fontWeight: "600",
    letterSpacing: 0.2,
  },
  copyModalDone: {
    color: "#7aa2f7",
    fontSize: 15,
    fontWeight: "600",
  },
  copyModalScroll: { flex: 1 },
  copyModalScrollContent: {
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  copyModalText: {
    color: "#e4e6ef",
    fontSize: 13,
    lineHeight: 18,
    fontFamily: Platform.select({
      ios: "Menlo",
      android: "monospace",
      default: "monospace",
    }),
  },

  dbgOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: "rgba(20, 21, 28, 0.85)",
    borderBottomWidth: 1,
    borderBottomColor: "#2a2d3d",
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  dbgText: {
    color: "#9ece6a",
    fontSize: 10,
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
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
