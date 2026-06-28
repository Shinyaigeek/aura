// A floating "show more" speed-dial in the bottom-right corner of the
// terminal. Collapsed, it's a single ⋯ toggle; expanded, it fans the action
// buttons out in a vertical stack above the toggle. New buttons drop in by
// adding an entry to the `actions` array — the layout grows upward on its own.
//
// `bottomOffset` lifts the whole dock by the height the on-screen key bar (and,
// on iOS, the keyboard) occupies, so the dock never covers the key bar's ENTER
// cap. The WebView reports that distance via the "k" message (see
// terminal-html.ts); Terminal threads it down here.

import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

export type DockAction = {
  /** Stable key for the list. */
  key: string;
  /** Icon shown when idle (emoji or glyph). */
  icon: string;
  /** Icon shown when `active` (e.g. a stop square while recording). */
  activeIcon?: string;
  /** Accessibility label / intent. */
  label: string;
  /** Highlighted (e.g. recording in progress). */
  active?: boolean;
  onPress: () => void;
};

export default function ActionDock({
  actions,
  bottomOffset = 0,
}: {
  actions: DockAction[];
  bottomOffset?: number;
}) {
  const [open, setOpen] = useState(false);
  if (actions.length === 0) return null;

  // Surface an in-progress action (e.g. recording) on the collapsed toggle so
  // the user can see it's running — and reach it in one tap to expand & stop —
  // without the menu having to stay open.
  const activeAction = actions.find((a) => a.active);

  return (
    <View pointerEvents="box-none" style={[styles.root, { bottom: 16 + bottomOffset }]}>
      {open &&
        actions.map((action) => (
          <Pressable
            key={action.key}
            onPress={action.onPress}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={action.label}
            style={({ pressed }) => [
              styles.fab,
              action.active && styles.fabActive,
              pressed && { opacity: 0.7 },
            ]}
          >
            <Text style={[styles.icon, action.active && styles.iconActive]}>
              {action.active && action.activeIcon ? action.activeIcon : action.icon}
            </Text>
          </Pressable>
        ))}
      <Pressable
        onPress={() => setOpen((o) => !o)}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel={open ? "Hide actions" : "Show actions"}
        style={({ pressed }) => [
          styles.fab,
          styles.toggle,
          (open || activeAction) && styles.fabActive,
          pressed && { opacity: 0.7 },
        ]}
      >
        <Text style={[styles.icon, (open || activeAction) && styles.iconActive]}>
          {open ? "✕" : activeAction ? (activeAction.activeIcon ?? activeAction.icon) : "⋯"}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: "absolute",
    right: 16,
    alignItems: "center",
    gap: 12,
  },
  fab: {
    width: 52,
    height: 52,
    borderRadius: 26,
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
  // The toggle sits flush at the dock's bottom; the gap above it spaces the
  // fanned-out actions.
  toggle: {},
  fabActive: {
    backgroundColor: "#3a1620",
    borderColor: "#f7768e",
  },
  icon: { fontSize: 22, color: "#c0caf5" },
  iconActive: { fontSize: 18, color: "#f7768e", fontWeight: "700" },
});
