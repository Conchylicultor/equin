/**
 * Patched values (`ResourceDefinition.patches`) — a pushed value whose changes
 * ship as what changed. Pins:
 *   - the first frame of a span is whole; a change after it is a `patch`
 *     against the version every holder holds; a root change is an `update`;
 *   - a holder joining mid-stream is answered from the base (no load), so the
 *     next patch applies to it as to the others;
 *   - a failed load and N→0 drop the base (the next frame is whole);
 *   - a patched resource is a plain pushed value (refused otherwise);
 *   - convergence: random changes, joins and leaves on several sockets — each
 *     socket folding its frames (a patch only onto its base version) ends on
 *     the truth.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { applyValuePatch } from "@plugins/packages/plugins/value-patch/core";
import { createHarness, rng, tick, type RecordedFrame } from "./test-support";

const Schema = z.object({ text: z.string(), parts: z.array(z.string()) });
type V = z.infer<typeof Schema>;

function setup(sockets = 1) {
  const h = createHarness({ sockets });
  let runs = 0;
  let value: V = { text: "", parts: [] };
  let fail = false;
  const resource = h.runtime.defineExternalResource(
    { key: "p", schema: Schema, validateParams: () => {}, patches: true },
    {
      mode: "push",
      loader: () => {
        runs++;
        if (fail) throw new Error("boom");
        return value;
      },
    },
  );
  const set = async (v: V) => {
    value = v;
    resource.notify({});
    await tick();
    await tick();
  };
  return {
    h,
    runs: () => runs,
    set,
    failNext: (on: boolean) => {
      fail = on;
    },
  };
}

/** What one socket holds after folding its frames for `p`, as a client would. */
function fold(frames: readonly RecordedFrame[]): {
  version: number;
  value: unknown;
  resubs: number;
} {
  let version = -1;
  let value: unknown;
  let resubs = 0;
  for (const f of frames) {
    if (f.key !== "p" || f.version === undefined) continue;
    if (f.version <= version) continue;
    if (f.kind === "patch") {
      if (f.base !== version) {
        resubs++;
        continue;
      }
      value = applyValuePatch(value, f.ops!);
    } else if (f.kind === "sub-ack" || f.kind === "update") {
      value = f.value;
    } else continue;
    version = f.version;
  }
  return { version, value, resubs };
}

describe("patched value", () => {
  test("whole first, then patches against the holders' version", async () => {
    const { h, set } = setup();
    await set({ text: "a", parts: [] });
    await h.subscribe("p");
    const ack = h.frames.at(-1)!;
    expect(ack).toMatchObject({
      kind: "sub-ack",
      value: { text: "a", parts: [] },
    });
    await set({ text: "abc", parts: ["x"] });
    const patch = h.frames.at(-1)!;
    expect(patch).toMatchObject({
      kind: "patch",
      base: ack.version,
      ops: [
        { at: ["text"], append: "bc" },
        { at: ["parts"], push: ["x"] },
      ],
    });
    expect("value" in patch).toBe(false);
    expect("etag" in patch).toBe(false);
    await set({ text: "abcd", parts: ["x"] });
    expect(h.frames.at(-1)).toMatchObject({
      kind: "patch",
      base: patch.version,
    });
    expect(fold(h.frames).value).toEqual({ text: "abcd", parts: ["x"] });
  });

  test("a change of the root itself ships the whole value", async () => {
    const h = createHarness();
    let value: string | null = "a";
    const r = h.runtime.defineExternalResource(
      {
        key: "p",
        schema: z.string().nullable(),
        validateParams: () => {},
        patches: true,
      },
      { mode: "push", loader: () => value },
    );
    await h.subscribe("p");
    value = "ab";
    r.notify({});
    await tick();
    await tick();
    expect(h.frames.at(-1)).toMatchObject({
      kind: "patch",
      ops: [{ at: [], append: "b" }],
    });
  });

  test("a holder joining mid-stream gets the base, not a load, and follows the next patch", async () => {
    const { h, set, runs } = setup(2);
    await set({ text: "a", parts: [] });
    await h.subscribe("p", {}, { socket: 0 });
    await set({ text: "ab", parts: [] });
    const before = runs();
    await h.subscribe("p", {}, { socket: 1 });
    expect(runs()).toBe(before);
    const ack = h.framesFor(1).at(-1)!;
    expect(ack).toMatchObject({
      kind: "sub-ack",
      value: { text: "ab", parts: [] },
    });
    await set({ text: "abc", parts: [] });
    for (const s of [0, 1]) {
      expect(h.framesFor(s).at(-1)).toMatchObject({
        kind: "patch",
        base: ack.version,
      });
      expect(fold(h.framesFor(s))).toMatchObject({
        value: { text: "abc", parts: [] },
        resubs: 0,
      });
    }
  });

  test("a failed load drops the base: the next frame is whole", async () => {
    const { h, set, failNext } = setup();
    await h.subscribe("p");
    await set({ text: "a", parts: [] });
    expect(h.frames.at(-1)).toMatchObject({ kind: "patch" });
    failNext(true);
    await set({ text: "ab", parts: [] });
    failNext(false);
    await set({ text: "abc", parts: [] });
    expect(h.frames.at(-1)).toMatchObject({
      kind: "update",
      value: { text: "abc", parts: [] },
    });
  });

  test("N→0 drops the base: the next span loads and starts whole", async () => {
    const { h, set, runs } = setup();
    await h.subscribe("p");
    await set({ text: "a", parts: [] });
    await h.unsub("p");
    await set({ text: "ab", parts: [] });
    const before = runs();
    await h.subscribe("p");
    expect(runs()).toBe(before + 1);
    expect(h.frames.at(-1)).toMatchObject({
      kind: "sub-ack",
      value: { text: "ab", parts: [] },
    });
  });

  test("a patched resource is a plain pushed value", () => {
    const h = createHarness();
    const contract = (key: string) => ({
      key,
      schema: Schema,
      validateParams: () => {},
      patches: true as const,
    });
    expect(() =>
      h.runtime.defineExternalResource(contract("inv"), {
        mode: "invalidate",
        loader: () => ({ text: "", parts: [] }),
      }),
    ).toThrow(/a patched resource is a plain pushed value/);
    expect(() =>
      h.runtime.defineExternalResource(contract("rev"), {
        mode: "push",
        loader: () => ({ text: "", parts: [] }),
        revalidate: async () => "s",
      }),
    ).toThrow(/a revalidate signature/);
  });

  test("converges under random changes, joins and leaves", async () => {
    for (let run = 0; run < 20; run++) {
      const r = rng(run + 1);
      const { h, set } = setup(3);
      let truth: V = { text: "", parts: [] };
      const held = [false, false, false];
      for (let step = 0; step < 40; step++) {
        const x = r();
        const s = Math.floor(r() * 3);
        if (x < 0.2 && !held[s]) {
          held[s] = true;
          await h.subscribe("p", {}, { socket: s });
        } else if (x < 0.27 && held[s]) {
          held[s] = false;
          await h.unsub("p", {}, { socket: s });
        } else {
          truth =
            x < 0.9
              ? {
                  ...truth,
                  text: truth.text + "t".repeat(1 + Math.floor(r() * 3)),
                }
              : x < 0.97
                ? { ...truth, parts: [...truth.parts, `p${step}`] }
                : { text: `reset${step}`, parts: [] };
          await set(truth);
        }
      }
      for (let s = 0; s < 3; s++) {
        if (!held[s]) continue;
        // Only the frames since this socket's latest sub-ack: an unsub drops
        // what it held, so a resub starts over.
        const frames = h.framesFor(s);
        const lastAck = frames.findLastIndex((f) => f.kind === "sub-ack");
        const out = fold(frames.slice(lastAck));
        expect(out.resubs).toBe(0);
        expect(out.value).toEqual(truth);
      }
    }
  });
});
