import type { TokenGroupFragment } from "@plugins/ui/plugins/theme-engine/core";
import {
  shadowFragment,
  type ShadowParams,
} from "@plugins/ui/plugins/tokens/plugins/shadow/core";

/** "Fill from…" shortcuts for the shadow group: whole tier sets, each with the params that made it. */
export const shadowShortcuts: {
  id: string;
  label: string;
  fragment: TokenGroupFragment;
}[] = [
  shortcut("default", "Default", {
    color: "0 0 0",
    opacity: 0.1,
    blur: "3px",
    spread: "0px",
    offsetX: "0",
    offsetY: "1px",
  }),
  shortcut("none", "None", {
    color: "0 0 0",
    opacity: 0,
    blur: "0px",
    spread: "0px",
    offsetX: "0",
    offsetY: "0px",
  }),
  shortcut("elevated", "Elevated", {
    color: "0 0 0",
    opacity: 0.15,
    blur: "8px",
    spread: "1px",
    offsetX: "0",
    offsetY: "4px",
  }),
  shortcut("heavy", "Heavy", {
    color: "0 0 0",
    opacity: 0.25,
    blur: "20px",
    spread: "4px",
    offsetX: "0",
    offsetY: "8px",
  }),
];

function shortcut(id: string, label: string, params: ShadowParams) {
  return { id, label, fragment: shadowFragment(params) };
}
