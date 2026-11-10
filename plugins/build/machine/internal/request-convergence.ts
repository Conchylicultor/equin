import { isMain } from "@plugins/infra/plugins/runtime-identity/core";

/**
 * Ask the gateway to run main's convergence (`./equin build --allow-main
 * --converge`) — an OPTIONAL edge of main's auto-build loop.
 *
 * The loop's load-bearing edges are the gateway's own: an advance of
 * `refs/heads/main`, its boot, and its previous run exiting with an edge
 * pending. Those fire whether or not this backend is up, which is the point
 * (`build/converge`). A backend adds only what the gateway cannot see: the
 * `compositions` config changing, and the clock a served composition's cadence
 * runs on. An extra edge is free — the run re-derives the whole decision, and
 * the gateway runs at most one at a time — and a missed one only delays a
 * composition to the next edge; main's own app is never waiting on this.
 *
 * Main only: auto-build follows main, and the gateway runs it for main alone.
 *
 * Throws when the gateway answers anything but 202 — including 404, a gateway
 * started without `-main-checkout` (older than this edge, or not the machine's
 * dev gateway): `./equin start --force` installs the current one.
 */
export async function requestConvergence(cause: string): Promise<void> {
  if (!isMain()) return;
  const resp = await fetch("http://localhost:9000/gateway/deploy/converge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cause }),
    // A wedge-breaker: the gateway answers before it spawns anything.
    signal: AbortSignal.timeout(30_000),
  });
  if (resp.status !== 202) {
    throw new Error(
      `[build] the gateway refused main's convergence request (${cause}): ` +
        `${resp.status} ${(await resp.text()).trim()}`,
    );
  }
}
