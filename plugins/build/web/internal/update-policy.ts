// The reload policy: WHEN a tab on an older build reloads into the served one
// (research/2026-11-17-global-lossless-reload.md, "The policy"). Pure decisions
// over the tab's update verdict (`useTabUpdate`) and the page's reload
// readiness (`primitives/dom/reload-readiness`); `UpdatePolicyRoot` binds them
// to timers and the reload, and the Update pill renders the affordance.
//
//   available ─┬─ holds            → wait                 (the pill: "Update waits for: …")
//              ├─ hidden           → reload now           (the common case)
//              ├─ !engaged, idle   → reload               (then a quiet "Updated" toast)
//              └─ engaged          → wait
//   required  ─┬─ no holds         → reload now           (lossless: kept state)
//              └─ holds            → reload when released (the pill: "Update waits for: …")
//   fault      → never auto-reload: a real bug, already reported
//
// The Update pill shows for the WHOLE time an update is pending, whatever the
// moment: the tab runs an older build than the one served, and the UI says so
// and offers it at once (a neutral pill — nothing is wrong). The automatic
// reload only spares the user the click.
//
// A reload is always `quietReload` (flush kept state, wait out holds), so no
// branch can lose what the user made.

import type { ReloadReadiness } from "@plugins/primitives/plugins/dom/plugins/reload-readiness/web";
import type { PendingUpdate, TabUpdate } from "../hooks/use-tab-update";

/**
 * How long the user must have been idle before a visible tab updates: the
 * readiness's `engaged` already covers the last 10 s of input, so this is the
 * rest of the design's 30 s.
 */
export const IDLE_BEFORE_UPDATE_MS = 20_000;

export function isPending(update: TabUpdate): update is PendingUpdate {
  return update.kind === "available" || update.kind === "required";
}

/** What the policy does about the update right now. */
export type UpdateMoment = "reload-now" | "reload-when-idle" | "wait";

/**
 * `blocked`: an automatic reload already moved this tab toward the same target
 * and it came back still behind — reloading again would loop, so the update is
 * left to the user (the pill offers it at once).
 */
export function updateMoment(
  update: TabUpdate,
  readiness: ReloadReadiness,
  blocked: boolean,
): UpdateMoment {
  if (!isPending(update) || blocked) return "wait";
  // `quietReload` waits out the holds itself; the pill names them meanwhile.
  if (update.kind === "required") return "reload-now";
  if (readiness.holds.length > 0) return "wait";
  if (readiness.hidden) return "reload-now";
  return readiness.engaged ? "wait" : "reload-when-idle";
}

/** What the Update pill shows — nothing while the tab runs the served build. */
export type UpdateAffordance =
  | { kind: "none" }
  /** A pending update held by running processes, named in the user's words. */
  | { kind: "waiting"; waitsFor: readonly string[] }
  /** A pending update nothing holds: it reloads at its moment, or on a click. */
  | { kind: "ready" }
  /** Plugins failed to load and no update explains it. */
  | { kind: "fault"; failedPaths: readonly string[] };

export function updateAffordance(
  update: TabUpdate,
  readiness: ReloadReadiness,
): UpdateAffordance {
  if (update.kind === "fault") {
    return { kind: "fault", failedPaths: update.failedPaths };
  }
  if (!isPending(update)) return { kind: "none" };
  const waitsFor = [...new Set(readiness.holds.map((h) => h.label))];
  return waitsFor.length > 0
    ? { kind: "waiting", waitsFor }
    : { kind: "ready" };
}
