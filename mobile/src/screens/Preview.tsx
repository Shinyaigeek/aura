import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { WebView } from "react-native-webview";

import type { RootStackParamList } from "../../App";

type Props = NativeStackScreenProps<RootStackParamList, "Preview">;

export default function PreviewScreen({ navigation, route }: Props) {
  const { url, sessionId } = route.params;

  useEffect(() => {
    navigation.setOptions({ title: `preview · ${sessionId}` });
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
            <Text style={styles.loadingText}>Loading {url}…</Text>
          </View>
        )}
        // Dev servers usually serve plain HTTP — same trade-off as the difit
        // viewer: the WebView itself loads from a non-https origin so there
        // is no mixed-content concern.
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
