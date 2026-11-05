import {
  leaveDarwinBackground,
  readDarwinBackground,
  type DarwinBackground,
} from "./darwin-background";

/**
 * The header the gateway's readiness probe carries while a backend boots: the
 * scheduling tier the gateway wants it in (`gateway/worktree.go`'s
 * `bootTierHeader`, pinned to this one by `spawn-priority:boot-tier-in-sync`).
 *
 * The gateway spawns a background-started backend under `taskpolicy -b` and
 * decides when it should leave — a browser joins the start, or the boot
 * outlives its base deadline (the escalation). It cannot carry that out from
 * outside (`taskpolicy -B -p <pid>` exits 0 and changes nothing), so it says
 * it here, on the probe it already sends every 100 ms, and the backend acts.
 * Before this, a demoted boot ran darwinbg to the end: 60–100 s of plugin
 * imports under load where the foreground took 2–9 s (file reads 6–15× slower,
 * 2026-11-05), then a SIGKILL at the readiness deadline. The gateway strips it
 * from every request it proxies, so only its own probe carries it.
 */
export const BOOT_TIER_HEADER = "X-Equin-Boot-Tier";

/** The tier values the probe carries (`bootTierBackground` / `bootTierForeground` in Go). */
export const BOOT_TIERS = {
  background: "background",
  foreground: "foreground",
} as const;

let followed = false;

/**
 * Act on a request's boot-tier header: the first one saying `foreground`
 * takes this process out of darwinbg for good (`leaveDarwinBackground`) and
 * answers the state read back — when it was darwinbg; a process already in
 * the foreground (a browser start, main) answers null, having moved nothing.
 * Any other request — no header, `background`, or after the first
 * `foreground` — answers null and costs a header read. One way only: the
 * gateway never asks a backend back into darwinbg.
 */
export function followGatewayBootTier(req: Request): DarwinBackground | null {
  if (followed) return null;
  if (req.headers.get(BOOT_TIER_HEADER) !== BOOT_TIERS.foreground) return null;
  followed = true;
  if (readDarwinBackground().kind !== "darwinbg") return null;
  return leaveDarwinBackground();
}
