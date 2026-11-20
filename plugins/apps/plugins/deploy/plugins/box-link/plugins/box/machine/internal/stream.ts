import {
  ndjsonResponse,
  type NdjsonEmit,
} from "@plugins/infra/plugins/ndjson-stream/server";
import { hostOnly } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/host-only/server";
import { getServerCommit } from "@plugins/build/plugins/server-build-id/server";
import {
  BOX_LINK_BEAT_MS,
  BOX_LINK_PROTOCOL_VERSION,
  boxLinkStreamEndpoint,
  type BoxBeatFrame,
  type BoxHelloFrame,
  type BoxHostMetrics,
  type BoxSignalFrame,
} from "@plugins/apps/plugins/deploy/plugins/box-link/core";
import { machineHandler } from "@plugins/infra/plugins/endpoints/machine";
import {
  BoxSignal,
  type BoxSignalSpec,
} from "@plugins/apps/plugins/deploy/plugins/box-link/plugins/box/server";
import { createHostSampler } from "./host-metrics";

/** What one stream needs of its host — injected so a test drives it fast. */
export interface BoxStreamDeps {
  sources: readonly BoxSignalSpec[];
  /** The build this box runs (`null` when its dist names none). */
  readBuildId(): Promise<string | null>;
  /** This backend's start (epoch ms). */
  startedAt: number;
  /** A fresh sampler per stream: its CPU delta is between its own beats. */
  sampler: { read(): Promise<BoxHostMetrics> };
  beatMs: number;
}

/** Resolves after `ms`, or at once when `signal` aborts (the timer cleared). */
function waitOrAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * The stream's producer. Subscribes to every signal source FIRST, then says
 * hello — so a change committed after the reader saw the hello (and ran its
 * catch-up pull) is always signalled — then beats at once (CPU `null`) and
 * every `beatMs` after. Returns when `signal` aborts (the reader went away),
 * having dropped every source's subscription and its timer.
 */
export async function produceBoxStream(
  emit: NdjsonEmit,
  signal: AbortSignal,
  deps: BoxStreamDeps,
): Promise<void> {
  const unsubscribes: (() => void)[] = [];
  try {
    for (const source of deps.sources) {
      if (signal.aborted) return;
      unsubscribes.push(
        await source.subscribe((payload) => {
          const frame: BoxSignalFrame = {
            kind: "signal",
            source: source.source,
            payload,
          };
          emit(frame);
        }),
      );
    }
    if (signal.aborted) return;
    const hello: BoxHelloFrame = {
      kind: "hello",
      v: BOX_LINK_PROTOCOL_VERSION,
      startedAt: deps.startedAt,
      buildId: await deps.readBuildId(),
      signals: deps.sources.map((s) => s.source),
    };
    emit(hello);
    let seq = 0;
    while (!signal.aborted) {
      const host = await deps.sampler.read();
      const beat: BoxBeatFrame = { kind: "beat", at: Date.now(), seq, host };
      seq += 1;
      emit(beat);
      await waitOrAbort(deps.beatMs, signal);
    }
  } finally {
    for (const unsubscribe of unsubscribes) unsubscribe();
  }
}

/**
 * `GET /api/host-only/box-link/stream` without its guard: the NDJSON stream
 * over this release's `BoxSignal` contributions.
 */
export function boxLinkStreamResponse(req: Request): Response {
  const deps: BoxStreamDeps = {
    sources: BoxSignal.getContributions(),
    readBuildId: getServerCommit,
    startedAt: Math.round(performance.timeOrigin),
    sampler: createHostSampler(),
    beatMs: BOX_LINK_BEAT_MS,
  };
  return ndjsonResponse(
    (emit, signal) => produceBoxStream(emit, signal, deps),
    {
      signal: req.signal,
    },
  );
}

/**
 * The route, answered only from the box itself (one gateway hop). Served by
 * the machine half alone: only a computer has a host to measure, and only a
 * computer is a box a link reaches.
 */
export const handleBoxLinkStream = machineHandler(
  boxLinkStreamEndpoint,
  hostOnly(boxLinkStreamResponse),
);
