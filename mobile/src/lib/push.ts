// Local-notification permission + tap routing.
//
// Aura no longer goes through Expo Push / FCM; the server fans events
// over its own /events WebSocket and we surface them as local
// notifications via expo-notifications (see lib/events-client.ts).
// What's left here is the OS-level plumbing that's still required:
//
//   - The default Android channel (heads-up delivery is per-channel).
//   - The runtime POST_NOTIFICATIONS request on Android 13+.
//   - The notification handler that keeps banners visible while aura
//     is foregrounded.
//   - A pubsub for notification taps so Terminal can jump to the
//     matching session tab.

import * as Notifications from "expo-notifications";
import { useEffect } from "react";
import { Platform } from "react-native";

import type { ServerConfig } from "./storage";

// Without this, Expo suppresses the OS banner for foreground notifications,
// which defeats the point — the user expects an alert when CC finishes
// regardless of whether aura happens to be on screen.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export type PushTapEvent = { sessionId: string };

type TapListener = (e: PushTapEvent) => void;

const tapListeners = new Set<TapListener>();
let tapSubscriptionStarted = false;
let responseSub: Notifications.Subscription | null = null;

function startTapSubscriptionOnce() {
  if (tapSubscriptionStarted) return;
  tapSubscriptionStarted = true;

  // Notification that launched the app from a cold start. getLastNotificationResponseAsync
  // returns it once; any later taps come in through the listener below.
  void Notifications.getLastNotificationResponseAsync().then((resp) => {
    const sessionId = extractSessionId(resp?.notification);
    if (sessionId) dispatchTap({ sessionId });
  });

  responseSub = Notifications.addNotificationResponseReceivedListener((resp) => {
    const sessionId = extractSessionId(resp.notification);
    if (sessionId) dispatchTap({ sessionId });
  });
}

function dispatchTap(e: PushTapEvent) {
  for (const l of tapListeners) l(e);
}

function extractSessionId(n: Notifications.Notification | null | undefined): string | null {
  const data = n?.request.content.data;
  if (!data) return null;
  const s = (data as { sessionId?: unknown }).sessionId;
  return typeof s === "string" && s.length > 0 ? s : null;
}

// subscribePushTap registers a listener for notification taps. The listener
// fires once per tap, carrying the sessionId attached to the notification's
// data payload. Returns an unsubscribe.
export function subscribePushTap(listener: TapListener): () => void {
  startTapSubscriptionOnce();
  tapListeners.add(listener);
  return () => {
    tapListeners.delete(listener);
  };
}

// Test-only. Not used in production code — here so a future dev-tools screen
// can tear down the native listener without restarting the app.
export function __stopTapSubscription() {
  if (responseSub) {
    responseSub.remove();
    responseSub = null;
  }
  tapSubscriptionStarted = false;
  tapListeners.clear();
}

// useNotificationPermission ensures the Android channel exists and the
// runtime POST_NOTIFICATIONS permission has been requested whenever cfg
// is set. We tie it to cfg presence so an unconfigured user isn't
// bothered with a permission dialog on first launch.
export function useNotificationPermission(cfg: ServerConfig | null) {
  const url = cfg?.url ?? "";
  const token = cfg?.token ?? "";

  useEffect(() => {
    if (!url || !token) return;
    let cancelled = false;

    (async () => {
      if (Platform.OS === "android") {
        await Notifications.setNotificationChannelAsync("default", {
          name: "default",
          importance: Notifications.AndroidImportance.DEFAULT,
          vibrationPattern: [0, 200, 100, 200],
          lightColor: "#7aa2f7",
        });
      }
      if (cancelled) return;

      const settings = await Notifications.getPermissionsAsync();
      const granted =
        settings.granted ||
        settings.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
      if (granted) return;

      await Notifications.requestPermissionsAsync({
        ios: {
          allowAlert: true,
          allowBadge: false,
          allowSound: true,
        },
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [url, token]);
}
