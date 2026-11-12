// Backend down before its data.
//
// Every backend serves one namespace against the database named by it. Dropping
// or replacing that database while the backend runs cuts its sessions
// (`DROP DATABASE … WITH (FORCE)`) and leaves it serving against nothing — it
// exits 1 and files a backend-exit report, or answers requests with errors —
// and a request arriving mid-replace cold-starts a fresh one onto the database
// being destroyed (report-1794167098-q99s8d: a composition reset did exactly
// this). So whatever destroys a namespace's data first stops its backend and
// HOLDS it down through the gateway (`POST /gateway/worktrees/<ns>/stop?hold=1`,
// `gateway/CLAUDE.md`), and only then touches the data. The `HeldBackend` this
// answers is what `database/admin`'s drop takes, so the order is not a
// convention a caller can forget.

import type { HeldBackend } from "@plugins/infra/plugins/worktree/plugins/backend-hold/core";
import { z } from "zod";
import {
  GATEWAY_PORT,
  type Namespace,
} from "@plugins/infra/plugins/namespace/core";

/** The gateway refused, or did not confirm, the hold — nothing was touched. */
export class BackendHoldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackendHoldError";
  }
}

const gatewayWorktreeUrl = (ns: Namespace, action: "stop" | "restart") =>
  `http://localhost:${GATEWAY_PORT}/gateway/worktrees/${encodeURIComponent(ns)}/${action}`;

// The only place a `HeldBackend` is built: after the gateway confirmed there is
// no backend to hold, or that it holds this one.
const held = (namespace: Namespace) => ({ namespace }) as HeldBackend;

const HeldStatus = z.object({ held: z.boolean().optional() });

/**
 * Stop the namespace's backend and HOLD it down: the gateway answers traffic
 * with "held" instead of cold-starting a backend, until a deploy start
 * (`startBackend`, `./equin build`) releases it — or the namespace is
 * deregistered (its spec removed), which ends it for good.
 *
 * Throws `BackendHoldError` unless the gateway confirms the hold: a gateway
 * that predates `?hold=1` stops the backend but holds nothing, and proceeding
 * on that would reopen the window this closes.
 *
 * Two answers mean nothing can be running, so there is nothing to hold: an
 * unreachable gateway (every backend is its child) and 404 (the namespace is
 * not registered, so the gateway cannot start it).
 */
export async function holdBackendDown(ns: Namespace): Promise<HeldBackend> {
  let resp: Response;
  try {
    resp = await fetch(`${gatewayWorktreeUrl(ns, "stop")}?hold=1`, {
      method: "POST",
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    if (err instanceof TypeError) return held(ns); // gateway down: no backend runs
    throw err;
  }
  if (resp.status === 404) return held(ns);
  const body = await resp.text();
  if (!resp.ok) {
    throw new BackendHoldError(
      `could not stop the backend of "${ns}" before destroying its data ` +
        `(gateway ${resp.status}: ${body.trim()}); nothing was touched.`,
    );
  }
  const status = HeldStatus.parse(JSON.parse(body));
  if (status.held !== true) {
    throw new BackendHoldError(
      `the gateway stopped the backend of "${ns}" but did not hold it down ` +
        `(it predates the held stop — main's next deploy updates it); refusing ` +
        `to destroy its data while traffic could boot a backend onto it. ` +
        `Nothing was touched; the backend cold-starts on the next request.`,
    );
  }
  return held(ns);
}

/**
 * Cold-start a held namespace's backend on its replaced data — a deploy start,
 * which is also what releases the hold. Waits for it to be ready, so a caller's
 * next request reaches the new one. An unreachable gateway or an unregistered
 * namespace starts nothing to wait for (it spawns on first request); any other
 * failure is thrown.
 */
export async function startBackend(backend: HeldBackend): Promise<void> {
  const ns = backend.namespace;
  let resp: Response;
  try {
    resp = await fetch(gatewayWorktreeUrl(ns, "restart"), {
      method: "POST",
      signal: AbortSignal.timeout(180_000),
    });
  } catch (err) {
    if (err instanceof TypeError) return; // gateway down: spawns on first request
    throw err;
  }
  if (resp.ok || resp.status === 404) return;
  throw new BackendHoldError(
    `the backend of "${ns}" failed to boot on its replaced data ` +
      `(gateway ${resp.status}: ${(await resp.text()).trim()}).`,
  );
}
