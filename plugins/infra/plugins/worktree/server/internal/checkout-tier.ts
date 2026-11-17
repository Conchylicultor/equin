import type { CheckoutTier } from "@plugins/infra/plugins/git/plugins/index-refresh/server";

/**
 * The tier of an agent's launch checkout's heavy children (the tree write, the
 * switch, the dependency-store copy, the install, the index refresh): a person
 * is waiting for the agent's first reply, and the checkout is the largest part
 * of that wait. Foreground.
 *
 * It was background (darwinbg: E-cores, throttled I/O) like every other
 * checkout write, and a cold checkout's every step ran ~2× slower for it.
 * Measured 2026-11-17, interleaved bursts of 3 cold checkouts from the pools,
 * same load: 9.5–10.9 s background, 5.1–5.6 s foreground (install 6.0 → 2.9 s,
 * tree write 2.4 → 1.3 s, index refresh 1.2 → 0.5 s), while main's
 * `/api/search` p50/p95 stayed 79/84 ms (81/86 ms during the background
 * bursts). Under host load — a darwinbg process queues behind every agent's
 * background build — the gap is wider.
 *
 * A spare refill's install and a release checkout pass `background` (nobody
 * waits on them); a spare's tree write is foreground, since it holds a
 * `worktree-mutate` slot launches queue on (spare.ts). A removal's deletes and
 * prunes are background by construction.
 */
export const LAUNCH_TIER: CheckoutTier = "foreground";
