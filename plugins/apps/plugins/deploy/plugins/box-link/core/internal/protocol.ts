import { z } from "zod";
import { cappedList } from "@plugins/packages/plugins/list-bound/core";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import type { HOST_ONLY_PREFIX } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/host-only/core";

// The box link's stream: one long-lived NDJSON GET a deployed box answers to
// this computer (over an SSH tunnel to its gateway's loopback port, or through
// this instance's own gateway for a demo's stand-in box). It carries SIGNALS,
// never data — the table mirror stays the one data path, so a lost frame costs
// nothing: every reconnect runs one catch-up pull.

/**
 * The stream's route on the box: a raw NDJSON GET (no typed answer — frames
 * read with `readBoxFrame`), served by box-link/box's machine half.
 */
export const boxLinkStreamEndpoint = defineEndpoint({
  route: "GET /api/host-only/box-link/stream",
  // Read by the computer holding the box link (over its SSH tunnel, or for a
  // demo's stand-in box through its own gateway), never by a browser.
  needsMachine: { feature: "The box link's stream" },
});

/** The stream's path on the box: a host-only route (Caddy 404s it publicly). */
export const BOX_LINK_STREAM_PATH = boxLinkStreamEndpoint.route.slice(
  "GET ".length,
) as `${typeof HOST_ONLY_PREFIX}box-link/stream`;

/**
 * The protocol version this code speaks. A box answering another `v` in its
 * hello is `outdated` (deploy it again); a newer box may ADD frame kinds,
 * which an older reader skips — so a new optional field or kind does not bump
 * it, a changed meaning does.
 */
export const BOX_LINK_PROTOCOL_VERSION = 1;

/** How often the box beats: well inside Bun's 60 s `idleTimeout`. */
export const BOX_LINK_BEAT_MS = 15_000;

/** The most signal sources one hello lists (a release's BoxSignal contributions). */
const MAX_SIGNAL_SOURCES = 64;

/**
 * What a box says about itself on connect: the protocol it speaks, when its
 * backend started (epoch ms), the build it runs (the commit its served bundle
 * was built from — `null` when its dist carries none) and the signal sources
 * its release contributes.
 */
export const BoxHelloFrameSchema = z.object({
  kind: z.literal("hello"),
  v: z.number().int(),
  startedAt: z.number(),
  buildId: z.string().nullable(),
  signals: cappedList(z.string(), { max: MAX_SIGNAL_SOURCES }),
});
export type BoxHelloFrame = z.infer<typeof BoxHelloFrameSchema>;

/**
 * The box's host metrics at one beat — what no database holds.
 *
 * - `cpu.busyPct` — the share of all cores busy since the PREVIOUS beat of
 *   this stream (Linux: `/proc/stat`, iowait counted idle; elsewhere the
 *   `os.cpus()` tick counters), `null` on a stream's first beat (no previous
 *   reading to take a delta from). Never a stand-in 0.
 * - `mem` — bytes in use (total minus what the system can hand out) and total.
 * - `disk` — the filesystem holding the install, bytes used and total.
 */
export const BoxHostMetricsSchema = z.object({
  cpu: z.object({
    busyPct: z.number().min(0).max(100).nullable(),
    cores: z.number().int().positive(),
    load1: z.number().nonnegative(),
  }),
  mem: z.object({
    used: z.number().nonnegative(),
    total: z.number().positive(),
  }),
  disk: z.object({
    used: z.number().nonnegative(),
    total: z.number().positive(),
  }),
  uptimeSec: z.number().nonnegative(),
});
export type BoxHostMetrics = z.infer<typeof BoxHostMetricsSchema>;

/** A heartbeat: every {@link BOX_LINK_BEAT_MS}, the first right after hello. */
export const BoxBeatFrameSchema = z.object({
  kind: z.literal("beat"),
  /** The box's clock (epoch ms). */
  at: z.number(),
  /** 0 for the stream's first beat, +1 for each after. */
  seq: z.number().int().nonnegative(),
  host: BoxHostMetricsSchema,
});
export type BoxBeatFrame = z.infer<typeof BoxBeatFrameSchema>;

/**
 * A signal one of the box's `BoxSignal` contributions raised. `payload` is
 * the owning plugin's to parse with its own schema (`onBoxSignal` on this
 * computer hands it over as `unknown`).
 */
export const BoxSignalFrameSchema = z.object({
  kind: z.literal("signal"),
  source: z.string(),
  payload: z.unknown(),
});
export type BoxSignalFrame = z.infer<typeof BoxSignalFrameSchema>;

export type BoxFrame = BoxHelloFrame | BoxBeatFrame | BoxSignalFrame;

/**
 * How one streamed value reads:
 *
 * - `frame` — a frame this code knows, well-formed;
 * - `skip` — a frame kind this code does not know (a newer box): ignored;
 * - `producer-error` — the box's producer threw (`ndjsonResponse` frames it
 *   as `{ error }`): the stream is over;
 * - `malformed` — a known kind that does not parse: a protocol bug, loud.
 */
export type BoxFrameRead =
  | { kind: "frame"; frame: BoxFrame }
  | { kind: "skip"; frameKind: string }
  | { kind: "producer-error"; message: string }
  | { kind: "malformed"; message: string };

const KNOWN_FRAMES = {
  hello: BoxHelloFrameSchema,
  beat: BoxBeatFrameSchema,
  signal: BoxSignalFrameSchema,
} as const;

/** Read one value of the stream (see {@link BoxFrameRead}). */
export function readBoxFrame(value: unknown): BoxFrameRead {
  if (typeof value !== "object" || value === null) {
    return {
      kind: "malformed",
      message: `not an object: ${JSON.stringify(value)}`,
    };
  }
  const record = value as Record<string, unknown>;
  if (!("kind" in record) && typeof record["error"] === "string") {
    return { kind: "producer-error", message: record["error"] };
  }
  const kind = record["kind"];
  if (typeof kind !== "string") {
    return {
      kind: "malformed",
      message: `a frame without a kind: ${JSON.stringify(value)}`,
    };
  }
  if (!Object.hasOwn(KNOWN_FRAMES, kind))
    return { kind: "skip", frameKind: kind };
  const parsed =
    KNOWN_FRAMES[kind as keyof typeof KNOWN_FRAMES].safeParse(value);
  if (!parsed.success) {
    return {
      kind: "malformed",
      message: `a "${kind}" frame that does not parse: ${parsed.error.message}`,
    };
  }
  return { kind: "frame", frame: parsed.data };
}
