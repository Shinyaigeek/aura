import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { mediaViewerHtml } from "@/lib/media-viewer-html";
import {
  httpBase,
  isImage,
  isVideo,
  listShares,
  shareItemUri,
  type SharedItem,
} from "@/lib/shares-client";
import type { ServerConfig } from "@/lib/storage";

type Props = {
  cfg: ServerConfig;
  onClose: () => void;
};

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; items: SharedItem[] };

// SharedGallery lists files the host has made available under AURA_SHARE_DIR —
// i.e. whatever Claude (or anything else on the server) dropped there to hand
// back to the user. Pull-to-refresh because there's no push channel for
// shares; the user opens this when they expect something to be waiting.
export default function SharedGallery({ cfg, onClose }: Props) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const [viewing, setViewing] = useState<SharedItem | null>(null);

  const refresh = useCallback(
    async (showSpinner: boolean) => {
      if (showSpinner) setRefreshing(true);
      try {
        const items = await listShares(cfg);
        setState({ kind: "ready", items });
      } catch (err) {
        setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        if (showSpinner) setRefreshing(false);
      }
    },
    [cfg],
  );

  useEffect(() => {
    void refresh(false);
  }, [refresh]);

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      <View style={styles.header}>
        <Text style={styles.title}>Shared with you</Text>
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
        <View style={styles.center}>
          <Text style={styles.errorText}>{state.message}</Text>
          <Pressable
            onPress={() => void refresh(true)}
            style={({ pressed }) => [styles.retryBtn, pressed && { opacity: 0.6 }]}
          >
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      )}

      {state.kind === "ready" && (
        <FlatList
          data={state.items}
          keyExtractor={(it) => it.name}
          numColumns={3}
          contentContainerStyle={state.items.length === 0 ? styles.center : styles.grid}
          columnWrapperStyle={state.items.length > 0 ? styles.row : undefined}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => void refresh(true)}
              tintColor="#7aa2f7"
            />
          }
          ListEmptyComponent={<EmptyState />}
          renderItem={({ item }) => <Tile cfg={cfg} item={item} onPress={() => setViewing(item)} />}
        />
      )}

      <Modal
        visible={viewing !== null}
        animationType="fade"
        presentationStyle="fullScreen"
        onRequestClose={() => setViewing(null)}
      >
        {viewing !== null && (
          <MediaViewer cfg={cfg} item={viewing} onClose={() => setViewing(null)} />
        )}
      </Modal>
    </SafeAreaView>
  );
}

function Tile({
  cfg,
  item,
  onPress,
}: {
  cfg: ServerConfig;
  item: SharedItem;
  onPress: () => void;
}) {
  const image = isImage(item);
  const video = isVideo(item);
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.tile, pressed && { opacity: 0.7 }]}
    >
      {image ? (
        <Image source={{ uri: shareItemUri(cfg, item) }} style={styles.thumb} resizeMode="cover" />
      ) : (
        <View style={[styles.thumb, styles.thumbFallback]}>
          <Text style={styles.thumbGlyph}>{video ? "▶" : "❏"}</Text>
        </View>
      )}
      <Text style={styles.tileName} numberOfLines={1}>
        {item.name}
      </Text>
      <Text style={styles.tileMeta}>{formatSize(item.size)}</Text>
    </Pressable>
  );
}

function EmptyState() {
  return (
    <View style={styles.emptyWrap}>
      <Text style={styles.emptyGlyph}>❏</Text>
      <Text style={styles.emptyTitle}>Nothing shared yet</Text>
      <Text style={styles.emptyBody}>
        In your session, drop a file into <Text style={styles.code}>$AURA_SHARE_DIR</Text> to show
        it here — for example{" "}
        <Text style={styles.code}>cp shot.png &quot;$AURA_SHARE_DIR/&quot;</Text>. Pull down to
        refresh.
      </Text>
    </View>
  );
}

// MediaViewer renders one shared file full-screen. It reuses the WebView +
// 'R' handshake pattern from FileViewer: the document posts 'R' when ready,
// then we inject the media descriptor. baseUrl is the server's http origin so
// the token-authed media URL is same-origin (no mixed-content block).
function MediaViewer({
  cfg,
  item,
  onClose,
}: {
  cfg: ServerConfig;
  item: SharedItem;
  onClose: () => void;
}) {
  const webRef = useRef<WebView | null>(null);
  const readyRef = useRef(false);

  const payload = useMemo(
    () =>
      JSON.stringify({
        kind: isImage(item) ? "image" : isVideo(item) ? "video" : "other",
        src: shareItemUri(cfg, item),
        name: item.name,
      }),
    [cfg, item],
  );

  const flush = useCallback(() => {
    if (readyRef.current && webRef.current) {
      webRef.current.injectJavaScript(
        `window.__auraSetMedia&&window.__auraSetMedia(${JSON.stringify(payload)});true;`,
      );
    }
  }, [payload]);

  // If the payload changes while already mounted (shouldn't, since item is
  // fixed per-mount), re-flush.
  useEffect(() => {
    flush();
  }, [flush]);

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      if (event.nativeEvent.data === "R") {
        readyRef.current = true;
        flush();
      }
    },
    [flush],
  );

  const source = useMemo(() => ({ html: mediaViewerHtml, baseUrl: `${httpBase(cfg)}/` }), [cfg]);

  return (
    <SafeAreaView style={styles.viewerContainer} edges={["top", "bottom"]}>
      <View style={styles.viewerHeader}>
        <Text style={styles.viewerTitle} numberOfLines={1}>
          {item.name}
        </Text>
        <Pressable
          onPress={onClose}
          hitSlop={10}
          style={({ pressed }) => [styles.closeBtn, pressed && { opacity: 0.5 }]}
        >
          <Text style={styles.closeText}>×</Text>
        </Pressable>
      </View>
      <WebView
        ref={webRef}
        originWhitelist={["*"]}
        source={source}
        onMessage={onMessage}
        javaScriptEnabled
        domStorageEnabled
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        mixedContentMode="always"
        setSupportMultipleWindows={false}
        style={styles.web}
        androidLayerType={Platform.OS === "android" ? "hardware" : undefined}
      />
    </SafeAreaView>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

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
  title: { flex: 1, color: "#e4e6ef", fontSize: 16, fontWeight: "600", letterSpacing: 0.2 },
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
  closeText: { color: "#c0caf5", fontSize: 20, lineHeight: 22, fontWeight: "600" },
  center: { flexGrow: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  errorText: { color: "#f7768e", fontSize: 14, textAlign: "center", marginBottom: 16 },
  retryBtn: {
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 8,
    backgroundColor: "#14151c",
    borderWidth: 1,
    borderColor: "#20222c",
  },
  retryText: { color: "#c0caf5", fontSize: 14, fontWeight: "600" },
  grid: { padding: 6 },
  row: { gap: 6, paddingHorizontal: 0 },
  tile: { flex: 1 / 3, margin: 6, maxWidth: "33%" },
  thumb: { width: "100%", aspectRatio: 1, borderRadius: 8, backgroundColor: "#14151c" },
  thumbFallback: {
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#20222c",
  },
  thumbGlyph: { color: "#6b7089", fontSize: 28 },
  tileName: { color: "#c0caf5", fontSize: 11, marginTop: 4 },
  tileMeta: { color: "#6b7089", fontSize: 10, marginTop: 1 },
  emptyWrap: { alignItems: "center", justifyContent: "center", padding: 32 },
  emptyGlyph: { color: "#2a2d3d", fontSize: 48, marginBottom: 16 },
  emptyTitle: { color: "#e4e6ef", fontSize: 16, fontWeight: "600", marginBottom: 8 },
  emptyBody: { color: "#8b90a8", fontSize: 13, lineHeight: 19, textAlign: "center" },
  code: {
    color: "#7aa2f7",
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
    fontSize: 12,
  },
  viewerContainer: { flex: 1, backgroundColor: "#0b0b0f" },
  viewerHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 6,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#1a1c26",
  },
  viewerTitle: { flex: 1, color: "#e4e6ef", fontSize: 15, fontWeight: "600", marginRight: 12 },
  web: { flex: 1, backgroundColor: "#0b0b0f" },
});
