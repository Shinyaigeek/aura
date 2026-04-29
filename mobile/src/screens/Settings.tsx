import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { useEffect, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import type { RootStackParamList } from "../../App";
import { loadConfig, saveConfig, type ServerConfig } from "@/lib/storage";

type Props = NativeStackScreenProps<RootStackParamList, "Settings">;

type FieldKey = "url" | "token";

export default function SettingsScreen({ navigation }: Props) {
  const [cfg, setCfg] = useState<ServerConfig>({ url: "", token: "" });
  const [loaded, setLoaded] = useState(false);
  const [focused, setFocused] = useState<FieldKey | null>(null);
  const [diagRunning, setDiagRunning] = useState(false);

  useEffect(() => {
    loadConfig().then((c) => {
      setCfg(c);
      setLoaded(true);
    });
  }, []);

  const onRunDiag = async () => {
    if (diagRunning) return;
    setDiagRunning(true);
    try {
      const report = await runNotificationDiag(cfg);
      Alert.alert("Notification diagnostics", report);
    } finally {
      setDiagRunning(false);
    }
  };

  const onSave = async () => {
    const trimmed: ServerConfig = {
      url: cfg.url.trim(),
      token: cfg.token.trim(),
    };
    if (!/^wss?:\/\//.test(trimmed.url)) {
      Alert.alert("Invalid URL", "Server URL must start with ws:// or wss://");
      return;
    }
    if (!trimmed.token) {
      Alert.alert("Missing token", "A shared auth token is required.");
      return;
    }
    await saveConfig(trimmed);
    navigation.goBack();
  };

  if (!loaded) return <View style={styles.container} />;

  const inputStyle = (key: FieldKey) => [styles.input, focused === key && styles.inputFocused];

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={styles.container}
    >
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Connection</Text>
          <Text style={styles.cardSubtitle}>
            Point the app at your aura-server and authenticate with the shared token.
          </Text>

          <View style={styles.field}>
            <Text style={styles.label}>Server URL</Text>
            <TextInput
              style={inputStyle("url")}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              placeholder="ws://desktop.lan:8787"
              placeholderTextColor="#4a4e63"
              value={cfg.url}
              onChangeText={(url) => setCfg((c) => ({ ...c, url }))}
              onFocus={() => setFocused("url")}
              onBlur={() => setFocused(null)}
            />
            <Text style={styles.hint}>
              Omit the /ws path — the app appends it. Use wss:// over the internet.
            </Text>
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>Auth token</Text>
            <TextInput
              style={inputStyle("token")}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              placeholder="AURA_TOKEN from the server"
              placeholderTextColor="#4a4e63"
              value={cfg.token}
              onChangeText={(token) => setCfg((c) => ({ ...c, token }))}
              onFocus={() => setFocused("token")}
              onBlur={() => setFocused(null)}
            />
          </View>
        </View>

        <Pressable
          onPress={onSave}
          style={({ pressed }) => [styles.saveButton, pressed && styles.saveButtonPressed]}
        >
          <Text style={styles.saveButtonText}>Save & connect</Text>
        </Pressable>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Notifications</Text>
          <Text style={styles.cardSubtitle}>
            Walks the permission → token → register chain and reports each step. Use this when push
            notifications aren't arriving.
          </Text>
          <Pressable
            onPress={onRunDiag}
            disabled={diagRunning}
            style={({ pressed }) => [
              styles.secondaryButton,
              pressed && styles.secondaryButtonPressed,
              diagRunning && styles.secondaryButtonDisabled,
            ]}
          >
            <Text style={styles.secondaryButtonText}>
              {diagRunning ? "Running…" : "Run notification diagnostics"}
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// runNotificationDiag walks the same chain usePushRegistration does, but
// surfaces every step so a user can see which one is failing on their device.
// Side-effects are intentional: we register the real token if one is obtainable
// so a successful diag also fixes the underlying problem.
async function runNotificationDiag(cfg: ServerConfig): Promise<string> {
  const lines: string[] = [];
  const fmt = (e: unknown) =>
    e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e);

  let granted = false;
  try {
    const cur = await Notifications.getPermissionsAsync();
    granted = cur.granted || cur.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
    lines.push(
      `permissions(now): granted=${cur.granted} status=${cur.status} canAskAgain=${cur.canAskAgain ?? "?"}`,
    );
  } catch (e) {
    lines.push(`permissions(now): ERR ${fmt(e)}`);
  }

  if (Platform.OS === "android") {
    try {
      await Notifications.setNotificationChannelAsync("default", {
        name: "default",
        importance: Notifications.AndroidImportance.DEFAULT,
        vibrationPattern: [0, 200, 100, 200],
        lightColor: "#7aa2f7",
      });
      lines.push("channel: ok");
    } catch (e) {
      lines.push(`channel: ERR ${fmt(e)}`);
    }
  }

  if (!granted) {
    try {
      const req = await Notifications.requestPermissionsAsync({
        ios: { allowAlert: true, allowBadge: false, allowSound: true },
      });
      granted = req.granted || req.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
      lines.push(
        `permissions(req): granted=${req.granted} status=${req.status} canAskAgain=${req.canAskAgain ?? "?"}`,
      );
    } catch (e) {
      lines.push(`permissions(req): ERR ${fmt(e)}`);
    }
  } else {
    lines.push("permissions(req): skipped (already granted)");
  }

  let token: string | null = null;
  try {
    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ??
      (Constants as unknown as { easConfig?: { projectId?: string } }).easConfig?.projectId;
    const tok = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
    token = tok.data;
    lines.push(`token: ${tok.data.slice(0, 28)}…`);
  } catch (e) {
    lines.push(`token: ERR ${fmt(e)}`);
  }

  if (!token) {
    lines.push("register: skipped (no token)");
  } else if (!cfg.url || !cfg.token) {
    lines.push("register: skipped (no server cfg)");
  } else {
    try {
      const base = cfg.url.replace(/\/+$/, "").replace(/^ws(s?):\/\//, "http$1://");
      const res = await fetch(`${base}/devices/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.token}`,
        },
        body: JSON.stringify({ expoPushToken: token, platform: Platform.OS }),
      });
      lines.push(`register: HTTP ${res.status}`);
    } catch (e) {
      lines.push(`register: ERR ${fmt(e)}`);
    }
  }

  return lines.join("\n");
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0b0b0f" },
  scroll: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 48 },

  card: {
    backgroundColor: "#14151c",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#20222c",
    padding: 20,
    marginBottom: 20,
  },
  cardTitle: {
    color: "#e4e6ef",
    fontSize: 18,
    fontWeight: "700",
    letterSpacing: 0.2,
    marginBottom: 6,
  },
  cardSubtitle: {
    color: "#8b90a8",
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 20,
  },

  field: { marginBottom: 18 },
  label: {
    color: "#9aa0bd",
    fontSize: 11,
    marginBottom: 8,
    textTransform: "uppercase",
    letterSpacing: 1.2,
    fontWeight: "600",
  },
  input: {
    backgroundColor: "#0e0f15",
    color: "#e4e6ef",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: "#242634",
    fontSize: 15,
    fontFamily: Platform.select({
      ios: "Menlo",
      android: "monospace",
      default: "monospace",
    }),
  },
  inputFocused: {
    borderColor: "#7aa2f7",
    backgroundColor: "#11131c",
  },
  hint: {
    color: "#6b7089",
    fontSize: 12,
    marginTop: 8,
    lineHeight: 17,
  },

  saveButton: {
    backgroundColor: "#7aa2f7",
    paddingVertical: 15,
    borderRadius: 12,
    alignItems: "center",
  },
  saveButtonPressed: { backgroundColor: "#6a8fe0" },
  saveButtonText: {
    color: "#0b0b0f",
    fontWeight: "700",
    fontSize: 16,
    letterSpacing: 0.3,
  },

  secondaryButton: {
    backgroundColor: "#1c2030",
    borderWidth: 1,
    borderColor: "#3b4262",
    paddingVertical: 13,
    borderRadius: 10,
    alignItems: "center",
    marginTop: 4,
  },
  secondaryButtonPressed: { backgroundColor: "#252a3d" },
  secondaryButtonDisabled: { opacity: 0.6 },
  secondaryButtonText: {
    color: "#c0caf5",
    fontWeight: "600",
    fontSize: 14,
    letterSpacing: 0.2,
  },
});
