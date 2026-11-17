// The reload policy: WHEN a tab on an older build reloads into the served one
// (research/2026-11-17-global-lossless-reload.md, "The policy"). Pure decisions
// over the tab's update verdict (`useTabUpdate`) and the page's reload
// readiness (`primitives/dom/reload-readiness`); `UpdatePolicyRoot` binds them
// to timers and the reload, and the Update pill renders the affordance.
//
//   available ─┬─ holds            → wait (the pill once overdue: "Update waits for: …")
//              ├─ hidden           → reload now           (the common case)
//              ├─ !engaged, idle   → reload               (then a quiet "Updated" toast)
//              └─ engaged          → wait (the pill once overdue)
//   required  ─┬─ no holds         → reload now           (lossless: kept state)
//              └─ holds            → reload when released (the pill: "Update waits for: …")
//   fault      → never auto-reload: a real bug, already reported
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

/**
 * How long a pending update may wait for its moment before the pill offers it:
 * a tab kept busy (ambient music playing for hours, a user never idle for 30 s)
 * would otherwise run the old build indefinitely, with nothing saying so.
 */
export const UPDATE_OVERDUE_MS = 10 * 60_000;

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

/** What the Update pill shows — nothing unless the user can act on something. */
export type UpdateAffordance =
  | { kind: "none" }
  /** A pending update held by running processes, named in the user's words. */
  | { kind: "waiting"; waitsFor: readonly string[] }
  /** A pending update nothing holds, that has not found its moment in time. */
  | { kind: "ready" }
  /** Plugins failed to load and no update explains it. */
  | { kind: "fault"; failedPaths: readonly string[] };

export function updateAffordance(
  update: TabUpdate,
  readiness: ReloadReadiness,
  flags: { overdue: boolean; blocked: boolean },
): UpdateAffordance {
  if (update.kind === "fault") {
    return { kind: "fault", failedPaths: update.failedPaths };
  }
  if (!isPending(update)) return { kind: "none" };
  const waitsFor = [...new Set(readiness.holds.map((h) => h.label))];
  // A required update reloads the moment its holds release, so it shows only
  // while they hold it; an available one waits silently for its moment until
  // it is overdue.
  const shown =
    update.kind === "required"
      ? waitsFor.length > 0 || flags.blocked
      : flags.overdue || flags.blocked;
  if (!shown) return { kind: "none" };
  return waitsFor.length > 0
    ? { kind: "waiting", waitsFor }
    : { kind: "ready" };
}
