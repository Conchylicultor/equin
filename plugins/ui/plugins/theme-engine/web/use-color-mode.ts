import { useCallback, useEffect, useState } from "react";
import { useConfig, useSetConfig } from "@plugins/config_v2/web";
import { COLOR_MODE_SCOPE_ID, themeSelectionConfig } from "../core";

export type ColorMode = "light" | "dark";
/** The CONFIGURED setting, before `system` is collapsed against the OS. */
export type ConfiguredColorMode = "light" | "dark" | "system";

// The hooks here take no scope argument, writer included: they all read
// COLOR_MODE_SCOPE_ID (core), the one config scope that owns light/dark.
//
// Per-scope dark mode is DEFERRED: `<html>.dark` is one global class, and the
// `color-scheme` property it drives is a document-level thing. So every reader of
// color mode — the class applier, the server painting the first frame's class,
// and prop-themed third-party widgets (sonner, charts, editors) — must resolve
// at the SAME scope, or they render different schemes on one screen.
//
// They did. Every call site picked its own scope: the class read global,
// the (since retired) pre-paint cache read the focused app's, and
// `useColorMode()` read the current app's. With a global `dark` and an app-scoped `light` that shipped a
// white first paint that flipped to dark once React mounted, and a light toaster
// over a dark app. Naming the scope ONCE, here, is what makes that class of
// disagreement unspellable: no caller can pass a different one.
//
// The WRITER is named here for the same reason. It used to live in theme-toggle,
// which wrote the current app's scope whenever that app had its own theme while
// every reader had already moved global — so the toggle flipped a value nothing
// painted from, and the button sat on a dark page offering to switch to dark.

/**
 * The CONFIGURED color mode (`light` | `dark` | `system`) of the scope that owns
 * light/dark, before `system` is collapsed against the OS.
 */
function useConfiguredColorMode(): ConfiguredColorMode {
  const { colorMode } = useConfig(themeSelectionConfig, {
    scopeId: COLOR_MODE_SCOPE_ID,
  }) as { colorMode: ConfiguredColorMode };
  return colorMode;
}

// Resolves the effective light/dark mode, collapsing the `system` setting against
// the OS `prefers-color-scheme` (with a live listener). This is THE single
// resolution of color mode — both the global `.dark` class applier and
// prop-themed third-party components (sonner, charts, editors) consume it, so the
// class, the `color-scheme` property, and every JS widget agree.
export function useResolvedColorMode(): ColorMode {
  const colorMode = useConfiguredColorMode();

  const [systemDark, setSystemDark] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches,
  );

  useEffect(() => {
    if (colorMode !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => setSystemDark(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [colorMode]);

  return colorMode === "dark" || (colorMode === "system" && systemDark)
    ? "dark"
    : "light";
}

// The resolved color mode — the same value driving the global `.dark` class. Use
// this to feed any component that themes itself via a prop (e.g.
// `<Sonner theme={useColorMode()} />`) instead of reading the class.
export function useColorMode(): ColorMode {
  return useResolvedColorMode();
}

/**
 * Sets the color mode of the scope that owns light/dark. The counterpart of
 * {@link useConfiguredColorMode}, deliberately living beside it: a writer that
 * named its own scope would flip a value the class applier never reads, which is
 * exactly the bug this file exists to make unspellable.
 */
export function useSetColorMode(): (mode: ConfiguredColorMode) => void {
  const set = useSetConfig(themeSelectionConfig, {
    scopeId: COLOR_MODE_SCOPE_ID,
  });
  return useCallback(
    (mode: ConfiguredColorMode) => set("colorMode", mode),
    [set],
  );
}
