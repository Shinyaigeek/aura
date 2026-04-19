import AsyncStorage from "@react-native-async-storage/async-storage";

export type ServerConfig = {
  url: string;
  token: string;
};

export type Tab = {
  id: string;
  label: string;
};

export type TabsState = {
  tabs: Tab[];
  activeTabId: string;
};

const CONFIG_KEY = "aura.server-config.v1";
const TABS_KEY = "aura.tabs.v1";

const defaultConfig: ServerConfig = { url: "", token: "" };

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
}

export async function loadTabs(): Promise<TabsState> {
  const raw = await AsyncStorage.getItem(TABS_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<TabsState>;
      const tabs = (parsed.tabs ?? []).filter(
        (t): t is Tab => !!t && typeof t.id === "string" && typeof t.label === "string",
      );
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
