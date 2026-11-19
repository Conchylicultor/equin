import { PRODUCT_NAME } from "@plugins/framework/plugins/product-name/core";

// What the app's own scopes are called, and how a process tells it already
// runs in one.
//
// The name IS the marker. A process reads its cgroup (`/proc/self/cgroup`) and
// knows from the leaf's name whether whoever started it already gave it a
// scope of its own — no environment variable to inherit into places it does
// not belong (an agent's scope must not make the build that agent runs look
// scoped already).

/**
 * The two kinds of work the app runs in a scope of its own, apart from what
 * serves (the gateway's unit: gateway, Postgres, PgBouncer, every backend):
 *
 * - `op` — work that runs and ends: a build, a check pass, a test run, a
 *   supervised run (a build, a job's child). A nested op (a build's own
 *   `./equin check`) stays in its parent's op scope: it is part of that work.
 * - `daemon` — a process started to outlive the backend that launched it (an
 *   sdk agent, a browser host, a release preview). Whatever it runs is its
 *   own, except an op it starts, which moves to an op scope of its own: an
 *   agent's build killed for memory leaves the agent to read the failure.
 */
export type ScopeKind = "op" | "daemon";

const KINDS: readonly ScopeKind[] = ["op", "daemon"];

/** A unit-name-safe spelling of a label: what systemd accepts, kept short. */
function unitSafe(label: string): string {
  const safe = label.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  if (safe === "")
    throw new Error(
      `[systemd-scope] ${JSON.stringify(label)} has nothing a unit name can carry`,
    );
  return safe.slice(0, 120);
}

/**
 * The scope unit for one piece of work: `<product>-<kind>-<label>.scope`.
 * `label` must be unique among live scopes (a run id, a build id, a pid and
 * an instant): systemd refuses a second live unit of one name, loudly.
 */
export function scopeUnitName(kind: ScopeKind, label: string): string {
  return `${PRODUCT_NAME}-${kind}-${unitSafe(label)}.scope`;
}

/**
 * The app's scope this process runs in, read from `/proc/self/cgroup`'s
 * text (cgroup v2: `0::/user.slice/…/app.slice/<unit>`): its kind and unit
 * when the leaf is one {@link scopeUnitName} named, else null — no scope, a
 * service, or someone else's scope (a terminal's `vte-spawn-….scope`).
 */
export function appScopeOf(
  procSelfCgroup: string,
): { kind: ScopeKind; unit: string } | null {
  const line = procSelfCgroup.split("\n").find((l) => l.startsWith("0::"));
  if (line === undefined) return null;
  const unit = line.slice(3).split("/").at(-1) ?? "";
  for (const kind of KINDS)
    if (unit.startsWith(`${PRODUCT_NAME}-${kind}-`) && unit.endsWith(".scope"))
      return { kind, unit };
  return null;
}
