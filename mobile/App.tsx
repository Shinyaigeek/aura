import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";

import SettingsScreen from "@/screens/Settings";
import TerminalScreen from "@/screens/Terminal";

export type RootStackParamList = {
  Terminal: undefined;
  Settings: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
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
