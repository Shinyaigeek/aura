import AsyncStorage from "@react-native-async-storage/async-storage";

export type ServerConfig = {
  url: string;
  token: string;
};

export type Tab = {
  id: string;
  label: string;
  // Set when the user manually renames a tab. Wins over both the auto-derived
  // session title (from server meta) and the default `label` so a human-chosen
  // name isn't clobbered by Claude transcript titles or session-N defaults.
  customLabel?: string;
};

export type TabsState = {
  tabs: Tab[];
  activeTabId: string;
};

const CONFIG_KEY = "aura.server-config.v1";
const TABS_KEY = "aura.tabs.v1";
const PREFS_KEY = "aura.prefs.v1";

const defaultConfig: ServerConfig = { url: "", token: "" };

// Prefs is for app-level toggles that don't fit on the Connection card —
// notably the foreground-service opt-in. Persisted in its own AsyncStorage
// key so a future migration to a Settings sub-screen doesn't have to
// touch ServerConfig.
export type Prefs = {
  // Keep aura alive in the background via a foreground service.
  // Trade-off: a persistent notification stays in the user's tray as
  // long as it's on, in exchange for ~3 min of background uptime
  // (Notifee uses Android's shortService type).
  keepAliveInBackground: boolean;
};

const defaultPrefs: Prefs = { keepAliveInBackground: false };

const defaultTabs: TabsState = {
  tabs: [{ id: "default", label: "default" }],
  activeTabId: "default",
};

// The v0 config schema carried a single `sessionId`. When we see that shape we
// seed the tabs state with that id so existing installs don't lose their
// running tmux session after the upgrade.
type LegacyConfig = Partial<ServerConfig> & { sessionId?: string };

export async function loadConfig(): Promise<ServerConfig> {
  const raw = await AsyncStorage.getItem(CONFIG_KEY);
  if (!raw) return defaultConfig;
  try {
    const parsed = JSON.parse(raw) as LegacyConfig;
    return { url: parsed.url ?? "", token: parsed.token ?? "" };
  } catch {
    return defaultConfig;
  }
}

export async function saveConfig(cfg: ServerConfig): Promise<void> {
  await AsyncStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
  for (const l of configListeners) l(cfg);
}

// Pub/sub on saveConfig so app-level effects (events client, notification
// permission) can react to Settings updates without polling. Subscribers
// fire after the AsyncStorage write resolves.
const configListeners = new Set<(cfg: ServerConfig) => void>();

export function subscribeConfig(listener: (cfg: ServerConfig) => void): () => void {
  configListeners.add(listener);
  return () => {
    configListeners.delete(listener);
  };
}

export async function loadPrefs(): Promise<Prefs> {
  const raw = await AsyncStorage.getItem(PREFS_KEY);
  if (!raw) return defaultPrefs;
  try {
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    return {
      keepAliveInBackground: parsed.keepAliveInBackground === true,
    };
  } catch {
    return defaultPrefs;
  }
}

export async function savePrefs(prefs: Prefs): Promise<void> {
  await AsyncStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  for (const l of prefsListeners) l(prefs);
}

const prefsListeners = new Set<(p: Prefs) => void>();

export function subscribePrefs(listener: (p: Prefs) => void): () => void {
  prefsListeners.add(listener);
  return () => {
    prefsListeners.delete(listener);
  };
}

export async function loadTabs(): Promise<TabsState> {
  const raw = await AsyncStorage.getItem(TABS_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<TabsState>;
      const tabs = (parsed.tabs ?? [])
        .filter((t): t is Tab => !!t && typeof t.id === "string" && typeof t.label === "string")
        .map((t) => {
          const custom = (t as Tab).customLabel;
          return typeof custom === "string" && custom.length > 0
            ? { id: t.id, label: t.label, customLabel: custom }
            : { id: t.id, label: t.label };
        });
      if (tabs.length === 0) return defaultTabs;
      const activeTabId =
        parsed.activeTabId && tabs.some((t) => t.id === parsed.activeTabId)
          ? parsed.activeTabId
          : tabs[0].id;
      return { tabs, activeTabId };
    } catch {
      // fall through to legacy migration
    }
  }

  const legacyRaw = await AsyncStorage.getItem(CONFIG_KEY);
  if (legacyRaw) {
    try {
      const legacy = JSON.parse(legacyRaw) as LegacyConfig;
      if (legacy.sessionId) {
        const migrated: TabsState = {
          tabs: [{ id: legacy.sessionId, label: legacy.sessionId }],
          activeTabId: legacy.sessionId,
        };
        await saveTabs(migrated);
        return migrated;
      }
    } catch {
      // ignore
    }
  }

  return defaultTabs;
}

export async function saveTabs(state: TabsState): Promise<void> {
  await AsyncStorage.setItem(TABS_KEY, JSON.stringify(state));
}

// nextTabId returns the smallest "session-N" not already in use, starting at 1.
// The `default` tab (if present) is ignored so fresh installs don't end up with
// `default` plus `session-1` side by side.
export function nextTabId(existing: readonly Tab[]): string {
  const taken = new Set(existing.map((t) => t.id));
  for (let n = 1; ; n++) {
    const id = `session-${n}`;
    if (!taken.has(id)) return id;
  }
}
