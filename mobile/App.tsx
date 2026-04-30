import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { useEventsClient } from "@/lib/events-client";
import { useNotificationPermission } from "@/lib/push";
import { loadConfig, type ServerConfig, subscribeConfig } from "@/lib/storage";
import SettingsScreen from "@/screens/Settings";
import TerminalScreen from "@/screens/Terminal";

export type RootStackParamList = {
  Terminal: undefined;
  Settings: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  // cfg lives at the App root so the /events subscription survives
  // navigation between Terminal and Settings. subscribeConfig refreshes
  // it whenever the user saves new credentials.
  const [cfg, setCfg] = useState<ServerConfig | null>(null);
  useEffect(() => {
    void loadConfig().then(setCfg);
    return subscribeConfig(setCfg);
  }, []);

  useNotificationPermission(cfg);
  useEventsClient(cfg);

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
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
