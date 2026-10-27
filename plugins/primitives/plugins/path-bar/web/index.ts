import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { PathBar, type PathBarProps } from "./internal/path-bar";
export type {
  PathBarSource,
  PathResolution,
  PathSegment,
  PathTarget,
  Suggestions,
} from "./internal/types";

export default {
  description:
    "Dolphin-style editable path bar: a breadcrumb (primitives/breadcrumb) that flips to a mono text field on a press of its empty space, the pencil or ⌘L, with a folder-completion combobox (↑/↓, Tab completes, Enter commits, Esc/blur revert, an invalid path stays in the field marked bad). Generic over a PathBarSource (segments / useComplete — a hook reading the typed text's completions live — / validate), so it imports no filesystem.",
  contributions: [],
} satisfies PluginDefinition;
