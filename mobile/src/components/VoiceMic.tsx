// Voice dictation: speech → text using on-device recognition
// (expo-speech-recognition → native SFSpeechRecognizer / Android
// SpeechRecognizer).
//
// Behaviour (per product decision): tap to start, tap again to stop. While
// recording, the live transcript shows in an overlay only — we never stream
// interim text into the PTY because there's no clean way to erase/replace it
// there. On stop, the assembled transcript is handed to `onTranscript`, which
// the terminal injects at the prompt WITHOUT a trailing newline so the user
// reviews and submits it themselves.
//
// The mic itself is rendered by ActionDock (the floating "show more" stack);
// this module owns the recognition state machine via `useVoiceDictation` and
// the live-transcript `VoiceOverlay`.

import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";
import { useCallback, useRef, useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";

export type VoiceDictation = {
  /** True while a recognition session is active. */
  recording: boolean;
  /** Live transcript (committed + interim) to show in the overlay. */
  display: string;
  /** Start if idle, stop (and emit) if recording. */
  toggle: () => void;
};

/**
 * Drives on-device speech recognition. Returns the recording flag, the live
 * transcript, and a toggle to start/stop. On stop, the final transcript is
 * passed to `onTranscript` (never empty).
 */
export function useVoiceDictation(
  lang: string,
  onTranscript: (text: string) => void,
): VoiceDictation {
  const [recording, setRecording] = useState(false);
  const [display, setDisplay] = useState("");

  // committedRef holds the concatenation of all finalized segments seen so far
  // this session; displayRef mirrors what's on screen (committed + current
  // interim) so the `end` handler can emit the latest text without waiting for
  // a state flush.
  const committedRef = useRef("");
  const displayRef = useRef("");

  const reset = useCallback(() => {
    committedRef.current = "";
    displayRef.current = "";
    setDisplay("");
    setRecording(false);
  }, []);

  useSpeechRecognitionEvent("start", () => setRecording(true));

  useSpeechRecognitionEvent("result", (e) => {
    const text = e.results[0]?.transcript ?? "";
    if (e.isFinal) {
      committedRef.current = joinSpoken(committedRef.current, text);
      displayRef.current = committedRef.current;
    } else {
      displayRef.current = joinSpoken(committedRef.current, text);
    }
    setDisplay(displayRef.current);
  });

  useSpeechRecognitionEvent("end", () => {
    const finalText = displayRef.current.trim();
    reset();
    if (finalText) onTranscript(finalText);
  });

  useSpeechRecognitionEvent("error", (e) => {
    // "no-speech" / "aborted" are benign (user stopped without speaking); only
    // surface the actionable ones.
    if (e.error !== "no-speech" && e.error !== "aborted") {
      Alert.alert("Voice input error", e.message || e.error);
    }
    reset();
  });

  const start = useCallback(async () => {
    try {
      const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!perm.granted) {
        Alert.alert(
          "Permission needed",
          "Allow microphone and speech recognition access to dictate prompts.",
        );
        return;
      }
      committedRef.current = "";
      displayRef.current = "";
      setDisplay("");
      ExpoSpeechRecognitionModule.start({
        lang,
        interimResults: true,
        continuous: true,
        addsPunctuation: true,
      });
    } catch (err) {
      Alert.alert("Voice input error", err instanceof Error ? err.message : String(err));
      reset();
    }
  }, [lang, reset]);

  const stop = useCallback(() => {
    // Graceful stop → flushes a final result, then the `end` event emits the
    // transcript. abort() would discard it.
    ExpoSpeechRecognitionModule.stop();
  }, []);

  const toggle = useCallback(() => {
    if (recording) stop();
    else void start();
  }, [recording, start, stop]);

  return { recording, display, toggle };
}

/**
 * The "Listening…" panel shown above the dock while dictation is active.
 * Renders nothing when idle. `bottomOffset` lifts it clear of the on-screen
 * key bar (same lift the dock uses).
 */
export function VoiceOverlay({
  recording,
  display,
  bottomOffset = 0,
}: {
  recording: boolean;
  display: string;
  bottomOffset?: number;
}) {
  if (!recording) return null;
  return (
    <View style={[styles.overlay, { bottom: 80 + bottomOffset }]} pointerEvents="none">
      <Text style={styles.overlayLabel}>Listening…</Text>
      <Text style={styles.overlayText} numberOfLines={4}>
        {display || "Speak your prompt"}
      </Text>
    </View>
  );
}

// joinSpoken concatenates transcript pieces with a single separating space,
// avoiding a leading space when the accumulator is empty.
function joinSpoken(acc: string, next: string): string {
  if (!next) return acc;
  if (!acc) return next;
  return `${acc} ${next}`;
}

const styles = StyleSheet.create({
  overlay: {
    position: "absolute",
    left: 16,
    right: 16,
    backgroundColor: "rgba(20, 21, 28, 0.96)",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#2a2d3d",
    padding: 14,
  },
  overlayLabel: {
    color: "#f7768e",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  overlayText: { color: "#e4e6ef", fontSize: 15, lineHeight: 21 },
});
