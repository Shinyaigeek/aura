import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { useEventsClient } from "@/lib/events-client";
import { useForegroundService } from "@/lib/foreground";
import { useNotificationPermission } from "@/lib/push";
import {
  loadConfig,
  loadPrefs,
  type Prefs,
  type ServerConfig,
  subscribeConfig,
  subscribePrefs,
} from "@/lib/storage";
import DifitScreen from "@/screens/Difit";
import SettingsScreen from "@/screens/Settings";
import TerminalScreen from "@/screens/Terminal";

export type RootStackParamList = {
  Terminal: undefined;
  Settings: undefined;
  Difit: { url: string; sessionId: string };
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  // cfg + prefs live at the App root so the /events subscription and
  // the foreground service survive navigation between Terminal and
  // Settings. subscribeConfig / subscribePrefs refresh state whenever
  // the user saves changes.
  const [cfg, setCfg] = useState<ServerConfig | null>(null);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  useEffect(() => {
    void loadConfig().then(setCfg);
    void loadPrefs().then(setPrefs);
    const unsubCfg = subscribeConfig(setCfg);
    const unsubPrefs = subscribePrefs(setPrefs);
    return () => {
      unsubCfg();
      unsubPrefs();
    };
  }, []);

  useNotificationPermission(cfg);
  useEventsClient(cfg);
  useForegroundService(prefs?.keepAliveInBackground ?? false);

  return (
    <SafeAreaProvider>
      <NavigationContainer>
        <StatusBar style="light" />
        <Stack.Navigator
          initialRouteName="Terminal"
          screenOptions={{
            headerStyle: { backgroundColor: "#0b0b0f" },
            headerTintColor: "#e4e6ef",
            headerTitleStyle: { fontWeight: "600" },
            headerShadowVisible: false,
            contentStyle: { backgroundColor: "#0b0b0f" },
          }}
        >
          <Stack.Screen name="Terminal" component={TerminalScreen} />
          <Stack.Screen
            name="Settings"
            component={SettingsScreen}
            options={{ title: "Settings", headerBackTitle: "Back" }}
          />
          <Stack.Screen
            name="Difit"
            component={DifitScreen}
            options={{ headerBackTitle: "Back" }}
          />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
