/**
 * An EXTERNAL resource's hand `notify()` attributed to the request that made
 * it (`attributeExternalNotify`): the write's id rides the recompute's frame as
 * `ackTx`, exactly as a change-feed source transaction does — so a predicted
 * write to a value whose truth lives outside Postgres (a config file) is
 * confirmed by the frame that shows it, never at an HTTP ack that can land
 * before that frame.
 */

import { test, expect, describe } from "bun:test";
import { z } from "zod";
import { createHarness, tick } from "./test-support";

/** A harness whose attribution answers whatever `current` holds at the call. */
function attributedHarness() {
  let current: string | undefined;
  const h = createHarness({ attributeExternalNotify: () => current });
  let value = 1;
  const r = h.runtime.defineExternalResource(
    { key: "doc", schema: z.number(), validateParams: () => {} },
    { mode: "push", loader: () => value },
  );
  return {
    h,
    r,
    set: (next: number) => {
      value = next;
    },
    attribute: (id: string | undefined) => {
      current = id;
    },
  };
}

const lastOf = (
  h: ReturnType<typeof createHarness>,
  kind: "update" | "ack",
): { ackTx?: string[] } | undefined =>
  h
    .pushesFor("doc")
    .filter((f) => f.kind === kind)
    .at(-1) as { ackTx?: string[] } | undefined;

describe("ackTx — an attributed external notify", () => {
  test("the update frame of the recompute carries the write's id", async () => {
    const x = attributedHarness();
    await x.h.subscribe("doc");
    x.set(2);
    x.attribute("eabc.1");
    x.r.notify();
    x.attribute(undefined);
    await tick();
    expect(lastOf(x.h, "update")?.ackTx).toEqual(["eabc.1"]);
  });

  test("an unattributed notify (a watcher, a job) stays ack-less", async () => {
    const x = attributedHarness();
    await x.h.subscribe("doc");
    x.set(2);
    x.r.notify();
    await tick();
    const update = lastOf(x.h, "update")!;
    expect("ackTx" in update).toBe(false);
  });

  test("a write that changed nothing still acks, to a tab that asked", async () => {
    const x = attributedHarness();
    await x.h.subscribe("doc", {}, { acks: true });
    x.attribute("eabc.2");
    x.r.notify();
    x.attribute(undefined);
    await tick();
    expect(lastOf(x.h, "ack")?.ackTx).toEqual(["eabc.2"]);
  });
});
