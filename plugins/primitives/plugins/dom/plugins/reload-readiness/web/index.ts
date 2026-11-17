import {
  Core,
  type PluginDefinition,
} from "@plugins/framework/plugins/web-sdk/core";
import { GestureWatcherRoot } from "./internal/gesture-watcher-root";

export {
  holdReload,
  readReloadReadiness,
  subscribeReloadReadiness,
  type ReloadHold,
  type ReloadReadiness,
} from "./internal/readiness-store";
export { useReloadHold, useReloadReadiness } from "./internal/hooks";
export { quietReload } from "./internal/quiet-reload";

export default {
  description:
    "Whether the tab may reload now, for the reload policy: holdReload(label) / useReloadHold(active, { label }) — a running process a reload would stop (playback, an upload in flight, a write not yet acked, a drag), taken inside the primitive that runs it; useReloadReadiness() → { holds, engaged, hidden } (engaged: a popup open, focus in an editable, a pressed pointer, or input in the last 10 s); quietReload() — flushKept, wait until no hold is left, flushKept again, reload. A page-wide gesture watcher (Core.Root) feeds engagement and visibility, and holds every drag (a pressed pointer that moved, a native drag) and every playing <video>/<audio> itself, so no library or feature can start one without its hold.",
  contributions: [Core.Root({ component: GestureWatcherRoot, scope: "page" })],
} satisfies PluginDefinition;
