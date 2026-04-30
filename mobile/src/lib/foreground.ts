// Optional Android foreground service that keeps the app process alive
// long enough for the /events socket to deliver notifications when aura
// has just been backgrounded.
//
// Why this exists: Android suspends backgrounded apps within seconds-to-
// minutes (OEM dependent). Without an FGS, the WebSocket dies and any
// Stop / Notification hook fired during that window is silently lost.
// With an FGS, the system contracts to keep our process alive while the
// service is running; we display a low-priority persistent notification
// to satisfy the contract's user-visibility requirement.
//
// Lifetime caveat: Notifee's bundled FGS declaration uses Android's
// `shortService` type, which has a HARD ~3 minute system-imposed cap.
// After that, Android kills the service regardless of what the JS
// runner is doing. Bumping to `dataSync` would extend this to hours
// but requires patching Notifee's shipped AndroidManifest, which means
// a custom config plugin — out of scope for now. 3 minutes is plenty
// for typical 1–2 minute Claude Code interactions on Pixel.

import notifee, { AndroidImportance } from "@notifee/react-native";
import { useEffect } from "react";
import { Platform } from "react-native";

const CHANNEL_ID = "aura-fgs";

// Register the FGS runner exactly once at module load. Notifee invokes
// it whenever the service starts; the function returning resolves the
// service back into stopped state. We block forever so the FGS lives
// until the system kills it (shortService cap) or until we explicitly
// call stopForegroundService.
if (Platform.OS === "android") {
  notifee.registerForegroundService(
    () =>
      new Promise<void>(() => {
        /* never resolves */
      }),
  );
}

let channelEnsured = false;

async function ensureChannel(): Promise<void> {
  if (channelEnsured) return;
  await notifee.createChannel({
    id: CHANNEL_ID,
    name: "Background reliability",
    importance: AndroidImportance.LOW,
    sound: undefined,
    vibration: false,
  });
  channelEnsured = true;
}

export async function startForegroundService(): Promise<void> {
  if (Platform.OS !== "android") return;
  await ensureChannel();
  await notifee.displayNotification({
    title: "aura",
    body: "Listening for Claude Code events",
    android: {
      channelId: CHANNEL_ID,
      asForegroundService: true,
      ongoing: true,
      pressAction: { id: "default" },
    },
  });
}

export async function stopForegroundService(): Promise<void> {
  if (Platform.OS !== "android") return;
  await notifee.stopForegroundService();
}

// useForegroundService starts the FGS while `enabled` is true and stops
// it otherwise. Mounted at App.tsx so the lifecycle survives navigation
// and tracks the Settings toggle directly.
export function useForegroundService(enabled: boolean) {
  useEffect(() => {
    if (Platform.OS !== "android") return;
    if (!enabled) {
      void stopForegroundService();
      return;
    }
    void startForegroundService();
    return () => {
      void stopForegroundService();
    };
  }, [enabled]);
}
