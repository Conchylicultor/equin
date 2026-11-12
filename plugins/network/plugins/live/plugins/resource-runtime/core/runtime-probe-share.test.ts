/**
 * Subscription `revalidate` probes of one tuple queued together for a
 * read-admission slot share ONE signature read (`computeEtag`'s
 * `queuedProbes`), as its loads share one flight (`runtime-gate-dedup`).
 *
 * From the restart-storm track (2026-11-12): a restart's replay restates every
 * tuple from every tab, and each tab's probe took its own slot to read the same
 * signature — `build.deployment`'s `git rev-parse` eight times per restart,
 * queued behind its own key's share.
 *
 * Sound only for a probe that has not started reading: its signature then
 * describes the state after every joiner registered. An admitted probe is
 * never joined, and an HTTP probe keeps its own read.
 */

import { test, expect, describe } from "bun:test";
import { hashHex } from "@plugins/packages/plugins/string-hash/core";
import { z } from "zod";
import {
  createHarness,
  controllable,
  tick,
  type Harness,
} from "./test-support";

const sig = (raw: string): string => hashHex(raw);

/** Six parked reads on two other keys: every read-admission slot held. */
async function fillGate(h: Harness) {
  const ctl = controllable("v");
  for (const key of ["slow-a", "slow-b"]) {
    h.runtime.defineExternalResource<string, { i: string }>({
      key,
      mode: "push",
      schema: z.string(),
      loader: () => ctl.loader(),
    });
  }
  ctl.block();
  for (const key of ["slow-a", "slow-b"])
    for (let i = 0; i < 3; i++) await h.subscribe(key, { i: String(i) });
  expect(h.runtime.readGateStats().active).toBe(6);
  return ctl;
}

/** A `revalidate` resource whose signature reads count and can be parked. */
function defineProbed(h: Harness) {
  const state = {
    sig: "1",
    probes: 0,
    loads: 0,
    park: null as null | Promise<void>,
  };
  h.runtime.defineExternalResource({
    key: "dep",
    mode: "push",
    schema: z.string(),
    loader: async () => {
      state.loads++;
      return `value ${state.sig}`;
    },
    revalidate: async () => {
      state.probes++;
      const at = state.sig;
      if (state.park) await state.park;
      return at;
    },
  });
  return state;
}

async function sharedProbesOf(h: Harness, key: string): Promise<number> {
  const res = await h.runtime.handleResourceHttp(
    new Request("http://localhost/api/resources/_debug"),
    { key: "_debug" },
  );
  const body = (await res.json()) as {
    resources: Array<{ key: string; sharedProbes: number }>;
  };
  return body.resources.find((r) => r.key === key)!.sharedProbes;
}

describe("queued revalidate probes share one signature read", () => {
  test("a replay herd queued behind a full gate reads the signature once and answers every tab up-to-date", async () => {
    const h = createHarness({ sockets: 4 });
    const state = defineProbed(h);
    const gate = await fillGate(h);

    for (let s = 0; s < 4; s++)
      await h.subscribe("dep", {}, { socket: s, etag: sig("1") });
    expect(state.probes).toBe(0); // all four queued, nothing read yet

    gate.release();
    await tick();
    expect(state.probes).toBe(1);
    expect(state.loads).toBe(0);
    const answers = h.frames.filter((f) => f.key === "dep");
    expect(answers.map((f) => f.kind)).toEqual([
      "up-to-date",
      "up-to-date",
      "up-to-date",
      "up-to-date",
    ]);
    expect(await sharedProbesOf(h, "dep")).toBe(3);
  });

  test("a change before the shared read starts reaches every joiner: none is answered up-to-date", async () => {
    const h = createHarness({ sockets: 2 });
    const state = defineProbed(h);
    const gate = await fillGate(h);

    await h.subscribe("dep", {}, { socket: 0, etag: sig("1") });
    state.sig = "2"; // the source moves while the first probe is still queued
    await h.subscribe("dep", {}, { socket: 1, etag: sig("1") });

    gate.release();
    await tick();
    expect(state.probes).toBe(1); // still one read — it ran after both registered
    for (const s of [0, 1]) {
      const ack = h.frames.find((f) => f.socket === s && f.key === "dep")!;
      expect(ack.kind).toBe("sub-ack");
      expect(ack.value).toBe("value 2");
      expect(ack.etag).toBe(sig("2"));
    }
  });

  test("an admitted probe is never joined: a later sub reads the signature itself", async () => {
    const h = createHarness({ sockets: 2 });
    const state = defineProbed(h);
    let unpark!: () => void;
    state.park = new Promise<void>((r) => (unpark = r));

    await h.subscribe("dep", {}, { socket: 0, etag: sig("1") }); // admitted, reading
    expect(state.probes).toBe(1);
    state.sig = "2";
    await h.subscribe("dep", {}, { socket: 1, etag: sig("1") });
    expect(state.probes).toBe(2); // its own read, of the moved source

    unpark();
    await tick();
    const first = h.frames.find((f) => f.socket === 0 && f.key === "dep")!;
    const second = h.frames.find((f) => f.socket === 1 && f.key === "dep")!;
    expect(first.kind).toBe("up-to-date"); // its read began before the move
    expect(second.kind).toBe("sub-ack"); // the move is never hidden from it
    expect(second.value).toBe("value 2");
    expect(await sharedProbesOf(h, "dep")).toBe(0);
  });

  test("an HTTP probe never rides a queued subscription probe", async () => {
    const h = createHarness();
    const state = defineProbed(h);
    const gate = await fillGate(h);

    await h.subscribe("dep", {}, { etag: sig("1") });
    const http = h.runtime.handleResourceHttp(
      new Request("http://localhost/api/resources/dep", {
        headers: { "If-None-Match": sig("1") },
      }),
      { key: "dep" },
    );
    gate.release();
    await tick();
    expect((await http).status).toBe(304);
    expect(state.probes).toBe(2);
    expect(await sharedProbesOf(h, "dep")).toBe(0);
  });
});
