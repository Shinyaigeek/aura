import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";

import type { RootStackParamList } from "../../App";
import {
  loadConfig,
  loadPrefs,
  type Prefs,
  saveConfig,
  savePrefs,
  type ServerConfig,
} from "@/lib/storage";

type Props = NativeStackScreenProps<RootStackParamList, "Settings">;

type FieldKey = "url" | "token";

export default function SettingsScreen({ navigation }: Props) {
  const [cfg, setCfg] = useState<ServerConfig>({ url: "", token: "" });
  const [prefs, setPrefs] = useState<Prefs>({ keepAliveInBackground: false });
  const [loaded, setLoaded] = useState(false);
  const [focused, setFocused] = useState<FieldKey | null>(null);

  useEffect(() => {
    Promise.all([loadConfig(), loadPrefs()]).then(([c, p]) => {
      setCfg(c);
      setPrefs(p);
      setLoaded(true);
    });
  }, []);

  const onToggleKeepAlive = (value: boolean) => {
    const next: Prefs = { ...prefs, keepAliveInBackground: value };
    setPrefs(next);
    void savePrefs(next);
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

        {Platform.OS === "android" && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Background</Text>
            <Text style={styles.cardSubtitle}>
              Keep aura listening for events for a few minutes after you switch away. A persistent
              notification stays in your tray while this is on (Android only).
            </Text>
            <View style={styles.toggleRow}>
              <Text style={styles.toggleLabel}>Keep alive in background</Text>
              <Switch
                value={prefs.keepAliveInBackground}
                onValueChange={onToggleKeepAlive}
                trackColor={{ false: "#242634", true: "#3b4262" }}
                thumbColor={prefs.keepAliveInBackground ? "#7aa2f7" : "#6b7089"}
              />
            </View>
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
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

  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  toggleLabel: {
    color: "#e4e6ef",
    fontSize: 14,
    fontWeight: "500",
    flex: 1,
    marginRight: 12,
  },
});
