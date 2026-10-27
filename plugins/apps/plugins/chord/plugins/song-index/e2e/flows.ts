// The song index's HTTP steps, shared by the scripts in this folder: open the
// index and wait for it, the loop find (its live value read over HTTP), and the
// response schema of next-chords.
//
// The status is read by polling its resource over HTTP (`waitFor`): these
// scripts have no browser session to subscribe with, and the harness offers no
// push wait.

import {
  agentFetch,
  waitFor,
  type Report,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  IndexStatusSchema,
  NextChordCountSchema,
  chordLoops,
  chordTokenFromParts,
  type ChordLoopsAnswer,
  type ChordToken,
  type FindLoopsInput,
  type IndexStatus,
} from "@plugins/apps/plugins/chord/plugins/song-index/core";
import { z } from "zod";

export async function postJson(path: string, body?: unknown): Promise<unknown> {
  const res = await agentFetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok)
    throw new Error(`POST ${path} → HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

/**
 * Where the index stands, read off its live resource over plain HTTP. Reading
 * it starts nothing — only `ensure` does — so a script that must not disturb
 * the instance (the curriculum's ladder preview) asks this and refuses when the
 * answer is not `ready`.
 */
export async function readStatus(): Promise<IndexStatus> {
  const res = await agentFetch("/api/resources/chord.index-status");
  if (!res.ok)
    throw new Error(
      `GET /api/resources/chord.index-status → HTTP ${res.status}`,
    );
  const { value } = z.object({ value: z.unknown() }).parse(await res.json());
  return IndexStatusSchema.parse(value);
}

/**
 * One loop find, read off the `chord.loops` live value over plain HTTP (no
 * browser session to subscribe with). Each call is a new round — a fresh
 * nonce, so a new tuple and a new random sample, as the trainer's refills are.
 * A refusal (`invalid-query`, HTTP 422) or any other failure throws.
 */
export async function findLoops(
  find: FindLoopsInput,
): Promise<ChordLoopsAnswer> {
  const { q } = chordLoops.query.encode({
    ...find,
    round: crypto.randomUUID(),
  });
  const path = `/api/resources/${encodeURIComponent(chordLoops.key)}?${new URLSearchParams({ q }).toString()}`;
  const res = await agentFetch(path);
  if (!res.ok)
    throw new Error(`GET ${path} → HTTP ${res.status}: ${await res.text()}`);
  const { value } = z.object({ value: z.unknown() }).parse(await res.json());
  return chordLoops.schema.parse(value);
}

export const NextResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("not-ready"), status: IndexStatusSchema }),
  z.object({
    kind: z.literal("ready"),
    nextChords: z.array(NextChordCountSchema),
  }),
]);

export const major = (root: number): ChordToken =>
  chordTokenFromParts({ root, intervals: [4, 3], inversion: 0 });
export const minor = (root: number): ChordToken =>
  chordTokenFromParts({ root, intervals: [3, 4], inversion: 0 });

/**
 * `ensure` the index and wait for it to settle, reporting each phase. Finishes
 * the report (a failure) unless it reaches `ready`.
 */
export async function ensureReady(r: Report, timeoutMs: number): Promise<void> {
  const opened = IndexStatusSchema.parse(
    await postJson("/api/chord/index/ensure"),
  );
  r.note(`ensure answered ${JSON.stringify(opened)}`);
  r.ok(
    "ensure records the request",
    opened.kind !== "not-requested",
    JSON.stringify(opened),
  );

  let lastPhase = "";
  const settled = await waitFor(
    async () => {
      const status = await readStatus();
      const phase =
        status.kind === "loading"
          ? `${status.phase} ${status.done ?? "-"}/${status.total ?? "-"}`
          : status.kind;
      if (phase !== lastPhase) r.note(`status: ${phase}`);
      lastPhase = phase;
      return status;
    },
    (status) => status.kind === "ready" || status.kind === "failed",
    { timeoutMs, intervalMs: 2_000 },
  );
  r.ok(
    "the index reaches ready",
    settled.value.kind === "ready",
    `${JSON.stringify(settled.value)} after ${Math.round(settled.waitedMs / 1000)} s`,
  );
  if (settled.value.kind !== "ready") await r.finish();
  r.note(
    `ready: ${JSON.stringify(settled.value)} (waited ${Math.round(settled.waitedMs / 1000)} s)`,
  );
}
