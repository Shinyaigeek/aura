// Push-notification registration + tap handling.
//
// Flow:
//   - On first launch (after the user has configured cfg), we request OS
//     notification permission and ask Expo for this install's push token.
//   - We POST that token to aura-server's /devices/register so the server's
//     Stop-hook fanout can reach us.
//   - A tap on a delivered notification surfaces { sessionId } from its data
//     payload via subscribePushTap so Terminal can focus that tab.
//
// We intentionally avoid silent retries: if registration fails (server down,
// permission denied), the effect re-runs whenever cfg changes, which is the
// usual way a user fixes it.

import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { useEffect } from "react";
import { Platform } from "react-native";

import type { ServerConfig } from "./storage";

// Configure how notifications surface while the app is foregrounded. Without
// this, Expo suppresses the OS banner for foreground pushes which is not what
// we want — the whole point is to alert the user to CC finishing while they
// are in another app.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// Convert a WebSocket config URL (ws://host:port) into the matching http
// base. Mirrors kill-session.ts — kept local to avoid lifting that helper
// out of its file for one caller.
function httpBase(url: string): string {
  return url.replace(/\/+$/, "").replace(/^ws(s?):\/\//, "http$1://");
}

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
// fires once per tap, carrying the sessionId the server attached to the push
// payload. Returns an unsubscribe.
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

// usePushRegistration requests permission + registers the Expo token with the
// aura-server whenever the config changes. On Android it also ensures a
// default notification channel exists (required for heads-up delivery).
export function usePushRegistration(cfg: ServerConfig | null) {
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

      const settings = await Notifications.getPermissionsAsync();
      let granted =
        settings.granted ||
        settings.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
      if (!granted) {
        const req = await Notifications.requestPermissionsAsync({
          ios: {
            allowAlert: true,
            allowBadge: false,
            allowSound: true,
          },
        });
        granted =
          req.granted || req.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
      }
      if (!granted) return;

      // EAS / Expo Go ships a projectId at runtime via Constants; when running
      // a local dev client without it, getExpoPushTokenAsync falls back to the
      // legacy flow. Both produce a usable ExponentPushToken[...] string.
      const projectId =
        Constants.expoConfig?.extra?.eas?.projectId ??
        (Constants as unknown as { easConfig?: { projectId?: string } }).easConfig?.projectId;
      let expoPushToken: string;
      try {
        const res = await Notifications.getExpoPushTokenAsync(
          projectId ? { projectId } : undefined,
        );
        expoPushToken = res.data;
      } catch (err) {
        // Most common cause: no APNs/FCM credentials in dev. Not worth
        // surfacing; retrying on next cfg change is fine.
        console.warn("getExpoPushTokenAsync failed", err);
        return;
      }
      if (cancelled) return;

      try {
        const res = await fetch(`${httpBase(url)}/devices/register`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ expoPushToken, platform: Platform.OS }),
        });
        if (!res.ok) {
          console.warn("device register failed", res.status);
        }
      } catch (err) {
        console.warn("device register request failed", err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [url, token]);
}
