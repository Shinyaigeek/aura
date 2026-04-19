import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect, useState } from "react";
import { Alert, KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";

import type { RootStackParamList } from "../../App";
import { loadConfig, saveConfig, type ServerConfig } from "@/lib/storage";

type Props = NativeStackScreenProps<RootStackParamList, "Settings">;

export default function SettingsScreen({ navigation }: Props) {
  const [cfg, setCfg] = useState<ServerConfig>({ url: "", token: "", sessionId: "default" });
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    loadConfig().then((c) => {
      setCfg(c);
      setLoaded(true);
    });
  }, []);

  const onSave = async () => {
    const trimmed: ServerConfig = {
      url: cfg.url.trim(),
      token: cfg.token.trim(),
      sessionId: cfg.sessionId.trim() || "default",
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

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={styles.container}
    >
      <View style={styles.field}>
        <Text style={styles.label}>Server URL</Text>
        <TextInput
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder="ws://desktop.lan:8787"
          placeholderTextColor="#6b6b6b"
          value={cfg.url}
          onChangeText={(url) => setCfg((c) => ({ ...c, url }))}
        />
        <Text style={styles.hint}>
          Without the /ws path — the app will append it. Use wss:// over the internet.
        </Text>
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>Auth token</Text>
        <TextInput
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          placeholder="AURA_TOKEN from the server"
          placeholderTextColor="#6b6b6b"
          value={cfg.token}
          onChangeText={(token) => setCfg((c) => ({ ...c, token }))}
        />
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>Session id</Text>
        <TextInput
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="default"
          placeholderTextColor="#6b6b6b"
          value={cfg.sessionId}
          onChangeText={(sessionId) => setCfg((c) => ({ ...c, sessionId }))}
        />
        <Text style={styles.hint}>
          Picks which long-lived tmux session to attach to. Change this to run multiple in parallel.
        </Text>
      </View>

      <TouchableOpacity style={styles.saveButton} onPress={onSave}>
        <Text style={styles.saveButtonText}>Save</Text>
      </TouchableOpacity>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, backgroundColor: "#0b0b0b" },
  field: { marginBottom: 20 },
  label: { color: "#cfcfcf", fontSize: 13, marginBottom: 6, textTransform: "uppercase", letterSpacing: 1 },
  input: {
    backgroundColor: "#151515",
    color: "#e5e5e5",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: "#262626",
    fontSize: 15,
  },
  hint: { color: "#7a7a7a", fontSize: 12, marginTop: 6 },
  saveButton: {
    backgroundColor: "#3a6df0",
    padding: 14,
    borderRadius: 8,
    alignItems: "center",
    marginTop: 8,
  },
  saveButtonText: { color: "white", fontWeight: "600", fontSize: 16 },
});
