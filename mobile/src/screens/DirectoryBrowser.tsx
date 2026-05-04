import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import type { CwdResponse, DirEntry, ListdirResponse, WsClient } from "@/lib/ws";

type Props = {
  client: WsClient | null;
  onClose: () => void;
  onPick: (path: string) => void;
  /** Heading shown in the sheet. Defaults to "Move to…". */
  title?: string;
  /** Label on the confirm button. Defaults to "Move here". */
  primaryLabel?: string;
  /** When set, regular files are listed alongside directories and tapping a
   * file invokes this callback (the modal stays open; caller decides). When
   * undefined, the server is asked for directories only — preserving the
   * upload-destination picker's "no files" behavior. */
  onPickFile?: (path: string) => void;
};

type Row = DirEntry | { name: ".."; isDir: true; synthetic: true };

export default function DirectoryBrowser({
  client,
  onClose,
  onPick,
  title = "Move to…",
  primaryLabel = "Move here",
  onPickFile,
}: Props) {
  const includeFiles = onPickFile !== undefined;
  const [path, setPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Guard against late responses from a superseded navigation clobbering newer
  // state (e.g. user taps B while A is still in flight).
  const requestSeqRef = useRef(0);

  const load = useCallback(
    async (target: string | null) => {
      const seq = ++requestSeqRef.current;
      setLoading(true);
      setError(null);

      if (!client) {
        if (requestSeqRef.current === seq) {
          setError("Not connected");
          setLoading(false);
        }
        return;
      }

      try {
        let resolvedPath = target;
        if (!resolvedPath) {
          const res = await client.request<CwdResponse>({ type: "cwd" });
          resolvedPath = res.path;
        }
        const dir = await client.request<ListdirResponse>({
          type: "listdir",
          path: resolvedPath,
          dirsOnly: !includeFiles,
        });
        if (requestSeqRef.current !== seq) return;
        setPath(dir.path);
        setEntries(dir.entries);
      } catch (e) {
        if (requestSeqRef.current !== seq) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (requestSeqRef.current === seq) setLoading(false);
      }
    },
    [client, includeFiles],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  const onRowPress = useCallback(
    (item: Row) => {
      if (!path) return;
      if (item.isDir) {
        const next = item.name === ".." ? parentPath(path) : joinPath(path, item.name);
        void load(next);
        return;
      }
      onPickFile?.(joinPath(path, item.name));
    },
    [path, load, onPickFile],
  );

  const onMoveHere = useCallback(() => {
    if (!path) return;
    onPick(path);
  }, [path, onPick]);

  const rows = buildRows(path, entries);

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      <View style={styles.header}>
        <Text style={styles.title}>{title}</Text>
        <Pressable
          onPress={onClose}
          hitSlop={10}
          style={({ pressed }) => [styles.closeBtn, pressed && { opacity: 0.5 }]}
        >
          <Text style={styles.closeText}>×</Text>
        </Pressable>
      </View>

      <View style={styles.pathBar}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.pathBarContent}
        >
          <Text style={styles.pathText} numberOfLines={1}>
            {path ?? "—"}
          </Text>
        </ScrollView>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color="#7aa2f7" />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable
            onPress={() => void load(path)}
            style={({ pressed }) => [styles.retryBtn, pressed && { opacity: 0.7 }]}
          >
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : rows.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyText}>
            {includeFiles ? "Nothing here." : "No subdirectories here."}
          </Text>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(item) => item.name}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => onRowPress(item)}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            >
              <Text style={[styles.rowIcon, !item.isDir && styles.rowIconFile]}>
                {item.name === ".." ? "↩" : item.isDir ? "▸" : "≡"}
              </Text>
              <Text style={styles.rowName} numberOfLines={1}>
                {item.name}
              </Text>
              {!item.isDir && item.size !== undefined && (
                <Text style={styles.rowMeta}>{formatSize(item.size)}</Text>
              )}
            </Pressable>
          )}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
        />
      )}

      <View style={styles.footer}>
        <Pressable
          onPress={onMoveHere}
          disabled={!path}
          style={({ pressed }) => [
            styles.primary,
            pressed && styles.primaryPressed,
            !path && styles.primaryDisabled,
          ]}
        >
          <Text style={styles.primaryText}>{primaryLabel}</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

function buildRows(path: string | null, entries: DirEntry[]): Row[] {
  const rows: Row[] = [];
  if (path && path !== "/") {
    rows.push({ name: "..", isDir: true, synthetic: true });
  }
  for (const e of entries) rows.push(e);
  return rows;
}

function parentPath(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return "/";
  return trimmed.slice(0, idx);
}

function joinPath(a: string, b: string): string {
  if (a.endsWith("/")) return a + b;
  return a + "/" + b;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0b0b0f" },

  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingTop: 6,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#1a1c26",
  },
  title: {
    color: "#e4e6ef",
    fontSize: 17,
    fontWeight: "600",
    letterSpacing: 0.3,
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

  pathBar: {
    backgroundColor: "#0e0f15",
    borderBottomWidth: 1,
    borderBottomColor: "#1a1c26",
  },
  pathBarContent: { paddingHorizontal: 18, paddingVertical: 10 },
  pathText: {
    color: "#9aa0bd",
    fontSize: 13,
    fontFamily: Platform.select({
      ios: "Menlo",
      android: "monospace",
      default: "monospace",
    }),
  },

  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  rowPressed: { backgroundColor: "#14151c" },
  rowIcon: {
    color: "#7aa2f7",
    fontSize: 16,
    width: 22,
    textAlign: "center",
    marginRight: 12,
  },
  rowIconFile: {
    color: "#9aa0bd",
  },
  rowName: {
    color: "#e4e6ef",
    fontSize: 15,
    flex: 1,
  },
  rowMeta: {
    color: "#6b7089",
    fontSize: 12,
    marginLeft: 10,
    fontFamily: Platform.select({
      ios: "Menlo",
      android: "monospace",
      default: "monospace",
    }),
  },
  separator: {
    height: 1,
    backgroundColor: "#14151c",
    marginLeft: 52,
  },

  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  errorText: {
    color: "#f7768e",
    fontSize: 14,
    textAlign: "center",
    marginBottom: 14,
  },
  emptyText: {
    color: "#6b7089",
    fontSize: 14,
  },
  retryBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: "#14151c",
    borderWidth: 1,
    borderColor: "#2a2d3d",
  },
  retryText: {
    color: "#c0caf5",
    fontSize: 14,
    fontWeight: "600",
  },

  footer: {
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: "#1a1c26",
    backgroundColor: "#0b0b0f",
  },
  primary: {
    backgroundColor: "#7aa2f7",
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  primaryPressed: { backgroundColor: "#6a8fe0" },
  primaryDisabled: { backgroundColor: "#2a2d3d" },
  primaryText: {
    color: "#0b0b0f",
    fontWeight: "700",
    fontSize: 15,
    letterSpacing: 0.3,
  },
});
