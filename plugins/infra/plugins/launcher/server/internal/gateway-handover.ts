/**
 * The gateway handover, from the launcher's side: replace the running gateway
 * PROCESS by another binary or launch with no request refused, no backend
 * stopped and no backend cold-started — the keeper (`gateway/keeper.go`) holds
 * the listening sockets and the backends across it. A gateway started before
 * the keeper existed has no handover route (404): the caller restarts its
 * service instead, as before.
 *
 * Design: research/2026-11-14-gateway-handover.md.
 */
import { z } from "zod";

/** What a handover runs; an omitted field keeps the running gateway's. */
export interface GatewayHandoverLaunch {
  binary?: string;
  args?: string[];
  /** `NAME=value` entries: the gateway's whole environment. */
  env?: Record<string, string>;
  dir?: string;
}

export type GatewayHandoverOutcome =
  | { kind: "handed-over"; pid: number; tookMs: number }
  /** The running gateway has no keeper (it predates it): restart it instead. */
  | { kind: "no-keeper" }
  /** The successor did not take over; the running gateway keeps serving. */
  | { kind: "failed"; reason: string };

const HandedOverSchema = z.object({
  handedOver: z.literal(true),
  pid: z.number(),
  tookMs: z.number(),
});

/**
 * A handover waits out lifecycle transitions in flight (a hot restart's
 * readiness window) and the successor's boot (its 60 s bound): never shorter.
 */
const HANDOVER_TIMEOUT_MS = 300_000;

/** Ask the gateway at `dialAddress` (`host:port`, dialled directly) to hand over. */
export async function handOverGateway(opts: {
  dialAddress: string;
  launch: GatewayHandoverLaunch;
}): Promise<GatewayHandoverOutcome> {
  const { launch } = opts;
  const body = {
    ...(launch.binary !== undefined ? { binary: launch.binary } : {}),
    ...(launch.args !== undefined ? { args: launch.args } : {}),
    ...(launch.env !== undefined
      ? { env: Object.entries(launch.env).map(([k, v]) => `${k}=${v}`) }
      : {}),
    ...(launch.dir !== undefined ? { dir: launch.dir } : {}),
  };
  const url = `http://${opts.dialAddress}/gateway/handover`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HANDOVER_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      kind: "failed",
      reason: `the gateway at ${url} did not answer: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (res.status === 404) return { kind: "no-keeper" };
  const text = await res.text();
  if (!res.ok) {
    return {
      kind: "failed",
      reason: `HTTP ${res.status}: ${text.trim()}`,
    };
  }
  const parsed = HandedOverSchema.parse(JSON.parse(text));
  return { kind: "handed-over", pid: parsed.pid, tookMs: parsed.tookMs };
}

const GenerationSchema = z.object({
  pid: z.number(),
  keeperPid: z.number(),
  binary: z.string(),
  args: z.array(z.string()),
});

/** The gateway generation serving now, as its keeper launched it. */
export type GatewayGeneration = z.infer<typeof GenerationSchema>;

export type GatewayGenerationRead =
  | { kind: "generation"; generation: GatewayGeneration }
  /** No keeper: the gateway process is the one its pidfile names. */
  | { kind: "no-keeper" }
  | { kind: "unreachable"; reason: string };

/**
 * Which gateway generation serves at `dialAddress`: under a keeper, the
 * process serving requests is not the one the service manager (and the
 * pidfile) names, and its command line is the last handover's, not the
 * installed definition's.
 */
export async function readGatewayGeneration(
  dialAddress: string,
): Promise<GatewayGenerationRead> {
  let res: Response;
  try {
    res = await fetch(`http://${dialAddress}/gateway/handover`, {
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) {
    return {
      kind: "unreachable",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  if (res.status === 404) return { kind: "no-keeper" };
  if (!res.ok) {
    return { kind: "unreachable", reason: `HTTP ${res.status}` };
  }
  return {
    kind: "generation",
    generation: GenerationSchema.parse(await res.json()),
  };
}
