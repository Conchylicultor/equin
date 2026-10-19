import { defineRoute } from "@plugins/primitives/plugins/pane/web";
import { prototypesApp } from "@plugins/apps/plugins/prototypes/plugins/shell/core";
import type {
  PrototypeViewport,
  StoredPicks,
} from "@plugins/apps/plugins/prototypes/plugins/files/core";
import { LIVE_VERSION, encodePicks, encodeSize } from "./present-link";

// The routes, apart from the panes that render them (`../panes.tsx`), so the
// pages' own components can link to each other without an import cycle.

/**
 * `present/<id>/<version>/<size>[/<picks>]`:
 *
 * - `version` — a recorded version's sha, or `live` for the live folder. It is
 *   required rather than optional because a route may have only ONE optional
 *   part, and it must be the last: `picks` needs that place.
 * - `size` — the size the frame opens at: `declared` (the prototype's own
 *   `<meta name="prototype-viewport">`), or a size word (`responsive`,
 *   `window`, `phone`, …). Required for the same reason as `version`.
 * - `picks` — the frame's OWN picks (`a=b,c=d`), so a frame other than A opens
 *   on its variant. Absent, the page reads the shared picks record, as frame A
 *   does.
 */
export const prototypePresentRoute = defineRoute({
  id: "prototypes-present",
  segment: "present/:name/:version/:size/:picks?",
});

/** The in-app path of one frame presented as a page of its own. */
export function presentPath({
  name,
  sha,
  picks,
  size,
}: {
  name: string;
  /** The recorded version on show — `undefined` for the live folder. */
  sha: string | undefined;
  /** The frame's own picks — `undefined` for frame A (the shared record). */
  picks: StoredPicks | undefined;
  /** The size to open at — `undefined` for the one the prototype declares. */
  size?: PrototypeViewport;
}): string {
  return prototypePresentRoute.link(prototypesApp, {
    name,
    version: sha ?? LIVE_VERSION,
    size: encodeSize(size),
    ...(picks === undefined ? {} : { picks: encodePicks(picks) }),
  });
}

/**
 * `present-canvas/<id>/<canvas>`: the whole canvas — every frame, its version
 * and picks, the size, zoom and layout — as `canvas` encodes it
 * (`encodeCanvas`). Frame A carries no picks: the page reads the shared record.
 */
export const prototypePresentCanvasRoute = defineRoute({
  id: "prototypes-present-canvas",
  segment: "present-canvas/:name/:canvas",
});

/** The in-app path of a canvas shown as a page of its own. */
export function presentCanvasPath(name: string, canvas: string): string {
  return prototypePresentCanvasRoute.link(prototypesApp, { name, canvas });
}
