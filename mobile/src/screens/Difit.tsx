import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { WebView } from "react-native-webview";

import type { RootStackParamList } from "../../App";

type Props = NativeStackScreenProps<RootStackParamList, "Difit">;

export default function DifitScreen({ navigation, route }: Props) {
  const { url, sessionId } = route.params;

  useEffect(() => {
    navigation.setOptions({
      title: `diff · ${sessionId}`,
    });
  }, [navigation, sessionId]);

  return (
    <View style={styles.container}>
      <WebView
        source={{ uri: url }}
        style={styles.web}
        startInLoadingState
        renderLoading={() => (
          <View style={styles.loading}>
            <ActivityIndicator color="#7aa2f7" />
            <Text style={styles.loadingText}>Loading diff…</Text>
          </View>
        )}
        // difit serves plain HTTP over the tunnel, no mixed-content concern
        // because the WebView itself loads from a non-https origin.
        originWhitelist={["*"]}
        javaScriptEnabled
        domStorageEnabled
        allowFileAccess={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0b0b0f" },
  web: { flex: 1, backgroundColor: "#0b0b0f" },
  loading: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#0b0b0f",
  },
  loadingText: { color: "#8b90a8", fontSize: 13, marginTop: 12 },
});
