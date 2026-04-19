import AsyncStorage from "@react-native-async-storage/async-storage";

export type ServerConfig = {
  url: string;
  token: string;
  sessionId: string;
};

const KEY = "aura.server-config.v1";

const defaults: ServerConfig = {
  url: "",
  token: "",
  sessionId: "default",
};

export async function loadConfig(): Promise<ServerConfig> {
  const raw = await AsyncStorage.getItem(KEY);
  if (!raw) return defaults;
  try {
    const parsed = JSON.parse(raw) as Partial<ServerConfig>;
    return { ...defaults, ...parsed };
  } catch {
    return defaults;
  }
}

export async function saveConfig(cfg: ServerConfig): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(cfg));
}
