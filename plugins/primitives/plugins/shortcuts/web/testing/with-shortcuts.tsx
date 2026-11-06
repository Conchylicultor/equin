import type { ReactNode } from "react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { Shortcuts } from "../slots";
import { ShortcutManager } from "../internal/shortcut-manager";

const plugins = [
  {
    id: "primitives.shortcuts",
    description: "shortcuts fixture",
    slots: Shortcuts,
    contributions: [],
  } as unknown as LoadedPlugin,
];

/**
 * The shortcut registry, live, around `children`: the one window keydown
 * listener that dispatches every `useSurfaceShortcuts` /
 * `usePlayPauseShortcut` registration. A jsdom suite that presses keys at a
 * component registering shortcuts renders it inside this, then dispatches
 * `keydown` events at the element the key should land on.
 */
export function WithShortcuts({ children }: { children: ReactNode }) {
  return (
    <PluginProvider plugins={plugins}>
      <ShortcutManager />
      {children}
    </PluginProvider>
  );
}
