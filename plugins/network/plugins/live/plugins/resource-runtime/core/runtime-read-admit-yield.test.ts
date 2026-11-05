/**
 * Read admission counts reads that RUN, not reads that wait. A read whose
 * loader joins work another caller is doing (an `inflight` join — a shared
 * memo's compute) gives its read-admission slot back for the wait, so reads
 * waiting on one slow read can never fill the gate in front of unrelated ones.
 * Run with `./equin test plugins/network/plugins/live/plugins/resource-runtime`.
 *
 * The 2026-11-03 incident on main: six values derived from one transcript held
 * all six slots while its 12 s read ran, and 131 unrelated reads waited ~12 s
 * (`wait read-admit took 11588ms`).
 * research/2026-11-03-framework-read-admission-waiters-yield.md
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { test, expect, describe, beforeAll } from "bun:test";
import { z } from "zod";
import { createInflight } from "@plugins/packages/plugins/inflight/core";
import {
  installLeaseContextRuntime,
  type LeaseScope,
} from "@plugins/packages/plugins/semaphore/core";
import { createHarness, controllable, tick } from "./test-support";

// What `runtime-profiler/server` installs at boot.
beforeAll(() => {
  const als = new AsyncLocalStorage<LeaseScope>();
  installLeaseContextRuntime({
    run: (scope, fn) => als.run(scope, fn),
    current: () => als.getStore(),
  });
});

/** One slow shared read (the transcript) and `n` values derived from it. */
function setup(n: number) {
  const h = createHarness();
  const memo = createInflight();
  const transcript = controllable("events");
  const readTranscript = () => memo.run("transcript", transcript.loader);
  for (let i = 0; i < n; i++) {
    h.runtime.defineExternalResource({
      key: `derived-${i}`,
      mode: "push",
      schema: z.string(),
      loader: async () => `${await readTranscript()}:${i}`,
    });
  }
  for (const key of ["places", "reports", "config"]) {
    h.runtime.defineExternalResource({
      key,
      mode: "push",
      schema: z.string(),
      loader: async () => key,
    });
  }
  const acked = (key: string) =>
    h.frames.some((f) => f.kind === "sub-ack" && f.key === key);
  return { h, transcript, readTranscript, acked };
}

describe("read admission — waiters give their slot back", () => {
  test("unrelated reads are served while six reads wait on one slow read", async () => {
    const { h, transcript, readTranscript, acked } = setup(6);
    transcript.block();
    // The slow read is already running (the transcript watcher's first read).
    const watcherRead = readTranscript();
    for (let i = 0; i < 6; i++) await h.subscribe(`derived-${i}`);
    for (const key of ["places", "reports", "config"]) await h.subscribe(key);
    await tick();

    // Every derived read only waits: none holds a slot, none blocks the rest.
    expect(h.runtime.readGateStats()).toMatchObject({
      active: 0,
      queued: 0,
      max: 6,
    });
    expect(acked("places")).toBe(true);
    expect(acked("reports")).toBe(true);
    expect(acked("config")).toBe(true);
    expect(acked("derived-0")).toBe(false); // it does depend on the slow read

    transcript.release();
    await watcherRead;
    await tick();
    for (let i = 0; i < 6; i++) {
      const ack = h.frames.find(
        (f) => f.kind === "sub-ack" && f.key === `derived-${i}`,
      );
      expect(ack?.value).toBe(`events:${i}`);
    }
    expect(h.runtime.readGateStats().active).toBe(0);
  });

  test("the read that does the slow work keeps its one slot; its joiners hold none", async () => {
    const { h, transcript, acked } = setup(6);
    transcript.block();
    // derived-0 STARTS the shared read inside its slot; the rest join it.
    for (let i = 0; i < 6; i++) await h.subscribe(`derived-${i}`);
    await h.subscribe("places");
    await tick();
    expect(h.runtime.readGateStats().active).toBe(1);
    expect(acked("places")).toBe(true);

    transcript.release();
    await tick();
    await tick();
    expect(
      h.frames.filter(
        (f) => f.kind === "sub-ack" && f.key?.startsWith("derived-"),
      ),
    ).toHaveLength(6);
    expect(h.runtime.readGateStats()).toMatchObject({
      active: 0,
      queued: 0,
      max: 6,
    });
  });

  test("a read that keeps running holds its slot: distinct running loads still cap at six", async () => {
    const h = createHarness();
    const ctl = controllable("v");
    // Eight keys, so no key's share (READ_KEY_SHARE) is what caps them.
    for (let k = 0; k < 8; k++) {
      h.runtime.defineExternalResource({
        key: `r${k}`,
        mode: "push",
        schema: z.string(),
        loader: () => ctl.loader(),
      });
    }
    ctl.block();
    for (let k = 0; k < 8; k++) await h.subscribe(`r${k}`);
    expect(h.runtime.readGateStats()).toMatchObject({
      active: 6,
      queued: 2,
      max: 6,
    });
    ctl.release();
    await tick();
    expect(h.runtime.readGateStats().active).toBe(0);
  });
});
