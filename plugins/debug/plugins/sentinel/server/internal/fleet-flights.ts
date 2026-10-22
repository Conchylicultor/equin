import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { z } from "zod";
import { defineTraceEventClass } from "@plugins/debug/plugins/trace/plugins/engine/server";
import { createSemaphore } from "@plugins/packages/plugins/semaphore/core";
import {
  asNamespace,
  namespaceUrl,
  type Namespace,
} from "@plugins/infra/plugins/namespace/core";

// The fleet-flights event class: on a cluster-onset trip (and ONLY then —
// enrich returns undefined for every other trigger, the engine's documented
// skip contract), fan out to every RUNNING backend's flight-window endpoint so
// the onset trace records what the whole fleet was doing at that instant.
//
// Gateway-mediated on purpose: worktree sockets and hot-swap generations are
// gateway-internal (the get_runtime_profile MCP precedent). The running-state
// filter is MANDATORY — proxying to a dormant backend cold-starts it
// (gateway/proxy.go handleHTTP → wt.Ensure), and spawning the whole fleet
// mid-incident would amplify the incident being recorded.

const GATEWAY_WORKTREES_URL = "http://localhost:9000/gateway/worktrees";
const FANOUT_CONCURRENCY = 4;
/** Per-backend budget: a wedged backend yields an error cell, never a stall. */
const PER_BACKEND_TIMEOUT_MS = 3_000;
const FLIGHT_WINDOW_MS = 15_000;

// Loose validation by design: each backend already zod-validates its own
// response, and the pane renders this section via the generic lane. Pinning
// the full FlightSpan shape here would break the fan-out on any backend
// running older/newer profiler code (fan-outs must tolerate mixed generations).
const FleetFlightCellSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    wallAnchor: z.object({ atMs: z.number(), wallTime: z.string() }),
    window: z.unknown(),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
const FleetFlightsSectionSchema = z.record(z.string(), FleetFlightCellSchema);
type FleetFlightCell = z.infer<typeof FleetFlightCellSchema>;

const GatewayWorktreeSchema = z.object({
  name: z.string(),
  state: z.string(),
});

async function fetchFlightWindow(name: Namespace): Promise<FleetFlightCell> {
  try {
    const res = await fetch(
      namespaceUrl(
        name,
        // Not callEndpoint: the fan-out reads every backend, on whatever code
        // it runs, so only `wallAnchor` is checked (see FleetFlightCellSchema)
        // — the contract's full schema would fail a mixed generation.
        // eslint-disable-next-line endpoints/no-raw-endpoint-call -- tolerates backends on older/newer profiler code
        `/api/debug/profiling/flight-window?windowMs=${FLIGHT_WINDOW_MS}`,
      ),
      { signal: AbortSignal.timeout(PER_BACKEND_TIMEOUT_MS) },
    );
    if (!res.ok) return { ok: false, error: `http ${res.status}` };
    const body = (await res.json()) as {
      wallAnchor?: unknown;
      window?: unknown;
    };
    const anchor = z
      .object({ atMs: z.number(), wallTime: z.string() })
      .safeParse(body.wallAnchor);
    if (!anchor.success) return { ok: false, error: "malformed wallAnchor" };
    return { ok: true, wallAnchor: anchor.data, window: body.window };
  } catch (err) {
    // The discriminated per-backend failure cell (the cluster fan-out pattern):
    // one wedged/timed-out backend yields an error cell in the section, never
    // aborting the whole onset enrich.
    return { ok: false, error: String(err) };
  }
}

export const fleetFlightsClass = defineTraceEventClass({
  id: "fleet-flights",
  schema: FleetFlightsSectionSchema,
  enrich: async (ctx) => {
    if (ctx.trigger.kind !== "cluster-onset") return undefined;

    const res = await fetch(GATEWAY_WORKTREES_URL, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) throw new Error(`gateway worktrees responded ${res.status}`);
    const fleet = z
      .array(GatewayWorktreeSchema.passthrough())
      .parse(await res.json());

    const self = runtimeNamespace();
    const targets = fleet.filter(
      (w) => w.state === "running" && w.name !== self,
    );
    const semaphore = createSemaphore(FANOUT_CONCURRENCY);
    const cells = await Promise.all(
      targets.map((w) =>
        semaphore.run(
          async () =>
            // The fleet list comes off the gateway's JSON — the asNamespace boundary.
            [w.name, await fetchFlightWindow(asNamespace(w.name))] as const,
        ),
      ),
    );
    return Object.fromEntries(cells);
  },
});
