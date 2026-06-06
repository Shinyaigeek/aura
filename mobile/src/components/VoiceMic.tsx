// Voice dictation control: a floating mic button over the terminal that turns
// speech into text using on-device recognition (expo-speech-recognition →
// native SFSpeechRecognizer / Android SpeechRecognizer).
//
// Behaviour (per product decision): tap to start, tap again to stop. While
// recording, the live transcript shows in an overlay only — we never stream
// interim text into the PTY because there's no clean way to erase/replace it
// there. On stop, the assembled transcript is handed to `onTranscript`, which
// the terminal injects at the prompt WITHOUT a trailing newline so the user
// reviews and submits it themselves.

import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";
import { useCallback, useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";

type Props = {
  /** BCP-47 locale to recognize in (e.g. "en-US", "ja-JP"). */
  lang: string;
  /** Called once, on stop, with the final transcript (never empty). */
  onTranscript: (text: string) => void;
};

export default function VoiceMic({ lang, onTranscript }: Props) {
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

  const onPress = useCallback(() => {
    if (recording) stop();
    else void start();
  }, [recording, start, stop]);

  return (
    <View pointerEvents="box-none" style={styles.root}>
      {recording && (
        <View style={styles.overlay} pointerEvents="none">
          <Text style={styles.overlayLabel}>Listening…</Text>
          <Text style={styles.overlayText} numberOfLines={4}>
            {display || "Speak your prompt"}
          </Text>
        </View>
      )}
      <Pressable
        onPress={onPress}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel={recording ? "Stop dictation" : "Start voice dictation"}
        style={({ pressed }) => [
          styles.fab,
          recording && styles.fabRecording,
          pressed && { opacity: 0.7 },
        ]}
      >
        <Text style={[styles.fabIcon, recording && styles.fabIconRecording]}>
          {recording ? "■" : "🎤"}
        </Text>
      </Pressable>
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
  root: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "flex-end",
    alignItems: "flex-end",
  },
  fab: {
    width: 52,
    height: 52,
    borderRadius: 26,
    margin: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#14151c",
    borderWidth: 1,
    borderColor: "#2a2d3d",
    // Float above the terminal content.
    shadowColor: "#000",
    shadowOpacity: 0.4,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 6,
  },
  fabRecording: {
    backgroundColor: "#3a1620",
    borderColor: "#f7768e",
  },
  fabIcon: { fontSize: 22, color: "#c0caf5" },
  fabIconRecording: { fontSize: 18, color: "#f7768e", fontWeight: "700" },
  overlay: {
    position: "absolute",
    left: 16,
    right: 16,
    bottom: 80,
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
