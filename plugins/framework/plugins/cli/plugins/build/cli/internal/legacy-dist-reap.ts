// One-shot migration reaper for the served dist that used to live INSIDE the
// checkout, at `<web-core>/{dist,dist.live.*,dist.staging.*,dist.swap.*,
// dist.old.*}`. Tens of MB to GB per checkout, and this repo has ~90 of them, so
// the trees cannot simply be abandoned. Deleted wholesale in S5, once no
// checkout can still be carrying one.
// research/2026-08-06-global-one-dist-per-namespace.md.
//
// THE GATE is the whole design, and getting it wrong is the one dangerous
// mistake available here: reap only if the RUNNING GATEWAY reports it is already
// serving the new location for this namespace. The gateway is the only authority
// on what it is serving — it holds an in-memory spec, and asking it is the only
// question whose answer cannot be stale.
//
// The gate used to ask `spec.json` on disk instead. That was WRONG and was
// observed to delete a live tree: a build rewrites the spec file, but a gateway
// that has already registered the namespace serves from its own in-memory copy,
// which it refreshes only on a reconcile tick / RefreshSpec. Disk saying the new
// path is therefore no evidence at all about what is being served, and the reap
// removed exactly the tree the gateway was still pointing at — every static
// asset 404'd while the build printed `BUILD OK — deployed`
// (research/2026-08-06-global-one-dist-per-namespace.md, "S4 IS NOT SAFE TO
// SHIP"). Gating on the gateway removes the time-based argument entirely: even
// once the gateway adopts a rewritten spec synchronously on the build's restart
// POST, a build whose restart never lands still leaves disk and gateway memory
// disagreeing until the next reconcile tick. The live reader's own answer has no
// such window.
//
// Reaping unconditionally at sweep time would delete the tree the gateway is
// serving RIGHT NOW, for the entire duration of the build: 404s on every asset
// for minutes. Reaping after `writeWorktreeSpec` instead would still race the
// gateway's adoption of it. Hence: gate, don't order.
//
// Consequence, by design: a namespace whose gateway registration predates its
// first post-S4 build reaps nothing until the gateway has adopted the new path
// (its next restart POST, reconcile tick, or a gateway restart). And on a bare
// release host — `build --hermetic`, no gateway at all — the gate is closed
// permanently, which costs nothing: a host with no gateway has no legacy served
// dist to reclaim either.

import { existsSync, readdir } from "@plugins/packages/plugins/timed-fs/core";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { worktreeArtifacts } from "@plugins/infra/plugins/paths/server";
import { distNames } from "./dist-publish";
import type { Namespace } from "@plugins/infra/plugins/namespace/core";

/** Where the gateway's own API lives, same origin `build` POSTs its restart to. */
const GATEWAY_ORIGIN = "http://localhost:9000";

/**
 * Short on purpose. A `--hermetic` build must stay hermetic: on a bare release
 * host nothing listens here, and the gate must cost that build ~nothing (a
 * refused connection is immediate; this bounds the pathological case of
 * something listening but not answering).
 */
const GATEWAY_TIMEOUT_MS = 2_000;

/**
 * What the RUNNING gateway says it is serving for one namespace. Three arms, not
 * a nullable string, because the reasons a caller learns nothing are distinct
 * facts and only one of them ("registered, and here is the path") can ever open
 * a destructive gate.
 */
export type GatewayWebPath =
  /** The gateway is registered for this namespace and serves statics from `web`. */
  | { kind: "serving"; web: string }
  /** The gateway answered, and does not know this namespace at all. */
  | { kind: "unknown" }
  /** No usable answer: unreachable, timed out, non-OK, or malformed. */
  | { kind: "unavailable"; reason: string };

/**
 * Ask the gateway which static root it has registered for `namespace`, via its
 * public `GET /gateway/worktrees` API (the `web` field of the entry whose `name`
 * matches). Never throws: every failure mode is an arm of the result, because
 * the only caller is a gate that must fail closed rather than abort a build.
 */
export async function readGatewayWebPath(
  namespace: string,
  origin: string = GATEWAY_ORIGIN,
): Promise<GatewayWebPath> {
  let resp: Response;
  try {
    resp = await fetch(`${origin}/gateway/worktrees`, {
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
  } catch (err) {
    // Gateway not running (connection refused) or the request timed out. Both
    // are ordinary on a bare release host, so this is reported, not thrown.
    return {
      kind: "unavailable",
      reason: `gateway unreachable at ${origin}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!resp.ok) {
    return {
      kind: "unavailable",
      reason: `gateway answered HTTP ${resp.status} at ${origin}`,
    };
  }
  let entries: unknown;
  try {
    entries = await resp.json();
  } catch (err) {
    return {
      kind: "unavailable",
      reason: `gateway sent unparseable JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!Array.isArray(entries)) {
    return {
      kind: "unavailable",
      reason: "gateway sent a non-array worktree list",
    };
  }
  const entry = (entries as Array<{ name?: unknown; web?: unknown }>).find(
    (e) => e !== null && typeof e === "object" && e.name === namespace,
  );
  if (!entry) return { kind: "unknown" };
  if (typeof entry.web !== "string" || entry.web === "") {
    return {
      kind: "unavailable",
      reason: `gateway entry for "${namespace}" has no web path`,
    };
  }
  return { kind: "serving", web: entry.web };
}

/**
 * The outcome of one reap attempt. A discriminated result rather than a bare
 * `string[]`, because the two ways of removing nothing are NOT the same fact and
 * a caller must not be able to conflate them: `reaped: []` means the gate was
 * open and the checkout is already clean (the steady state after S4), while
 * `skipped` means the gate refused — the trees, if any, are still on disk.
 * Collapsing the latter into an empty array would republish "I declined" as
 * "there was nothing to do".
 */
export type LegacyReapResult =
  { kind: "reaped"; entries: string[] } | { kind: "skipped"; reason: string };

/**
 * Reclaim the legacy in-checkout served dist, gated on the RUNNING GATEWAY
 * reporting `worktreeArtifacts.webDist(namespace)` as what it currently serves
 * for `namespace`.
 *
 * The gate FAILS CLOSED — a gateway still naming the old path, a namespace it
 * has never registered, an unreachable or slow gateway, a malformed answer, a
 * missing field: all mean "do not reap". "Don't know what is being served" is
 * exactly the state in which deleting gigabytes is least defensible.
 *
 * It also never throws a build. This runs in the *sweep* step, before the build
 * has produced anything, and it is one-shot cleanup: aborting the run that would
 * itself migrate the namespace is strictly worse than leaving the tree one more
 * build. The refusal is not silenced — it is reported through the returned
 * `reason`, which names the path the gateway actually gave.
 */
export async function reapLegacyCheckoutDist(opts: {
  /** The checkout's web-core dir — the legacy dist's parent. */
  webDir: string;
  /** The namespace whose gateway registration is the gate (this checkout's own). */
  namespace: Namespace;
  /** Gateway origin override; tests only — production always asks the real one. */
  gatewayOrigin?: string;
}): Promise<LegacyReapResult> {
  // Both sides are produced by `worktreeArtifacts.webDist` — the build writes
  // `web: webDistPath({kind:"served",name})` into the spec the gateway loads —
  // so this is an absolute-path identity comparison, not a string coincidence.
  const migrated = worktreeArtifacts.webDist(opts.namespace);
  const gateway = await readGatewayWebPath(opts.namespace, opts.gatewayOrigin);
  if (gateway.kind === "unavailable") {
    return {
      kind: "skipped",
      reason: `${gateway.reason} — cannot prove what is being served, so the legacy tree stays`,
    };
  }
  if (gateway.kind === "unknown") {
    return {
      kind: "skipped",
      reason: `gateway does not know namespace "${opts.namespace}" — nothing proves the legacy tree is unserved`,
    };
  }
  if (gateway.web !== migrated) {
    return {
      kind: "skipped",
      reason: `gateway is serving ${gateway.web} for "${opts.namespace}", not ${migrated} — reaping now would delete the live tree`,
    };
  }

  if (!existsSync(opts.webDir)) return { kind: "reaped", entries: [] };
  // Same spelling the publisher uses, derived rather than retyped, so the set of
  // transient siblings can never drift from `dist-publish`'s own.
  const { base, prefixes } = distNames(join(opts.webDir, "dist"));
  const removed: string[] = [];
  for (const entry of await readdir(opts.webDir)) {
    const legacy =
      entry === base ||
      entry.startsWith(prefixes.staging) ||
      entry.startsWith(prefixes.live) ||
      entry.startsWith(prefixes.swap) ||
      entry.startsWith(prefixes.old);
    if (!legacy) continue;
    await rm(join(opts.webDir, entry), { recursive: true, force: true });
    removed.push(entry);
  }
  return { kind: "reaped", entries: removed };
}
