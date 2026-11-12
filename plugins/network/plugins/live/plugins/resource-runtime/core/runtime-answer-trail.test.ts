/**
 * The answer trail (`GET /api/resources/_answer`): where the runtime stands on
 * one subscription request — read or not, queued for a read-admission slot
 * (and behind whom), loading, answered — kept by the runtime itself, so a
 * host with no profiler (a browser host) can still split a sub a tab saw go
 * unanswered (report-1794443597-ffjyfz: a /demo host left `saved-themes.list`
 * unanswered 63 s and nothing could say where).
 */

import { test, expect, describe } from "bun:test";
import { z } from "zod";
import {
  parseAnswerTrail,
  type AnswerTrail,
} from "@plugins/network/plugins/live/plugins/resource-protocol/core";
import {
  createHarness,
  controllable,
  tick,
  type Harness,
} from "./test-support";

async function trailOf(
  h: Harness,
  q: {
    tabId: string;
    id: number;
    key: string;
    params?: Record<string, string>;
  },
): Promise<AnswerTrail> {
  const qs = new URLSearchParams({
    tabId: q.tabId,
    id: String(q.id),
    key: q.key,
    params: JSON.stringify(q.params ?? {}),
  });
  const res = await h.runtime.handleResourceHttp(
    new Request(`http://localhost/api/resources/_answer?${qs}`),
    { key: "_answer" },
  );
  expect(res.status).toBe(200);
  return parseAnswerTrail(await res.json());
}

/** Six parked reads of `slow`: every read-admission slot held (two keys at their share). */
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
  return ctl;
}

describe("answer trail", () => {
  test("a request never read has no record; its tuple's stages and the gate still answer", async () => {
    const h = createHarness();
    const t = await trailOf(h, { tabId: "tab-a", id: 7, key: "nothing" });
    expect(t.request).toEqual({ kind: "no-record" });
    expect(t.queued).toBeNull();
    expect(t.loading).toBeNull();
    expect(t.gate).toMatchObject({ active: 0, queued: 0, max: 6 });
  });

  test("a read queued behind a full gate: received, queued, and the holders it waits behind", async () => {
    const h = createHarness();
    const ctl = await fillGate(h);
    h.runtime.defineExternalResource<string, { id: string }>({
      key: "row",
      mode: "push",
      schema: z.string(),
      loader: async ({ id }) => `row ${id}`,
    });
    await h.subscribe("row", { id: "a" }, { tabId: "tab-a", id: 3 });

    const t = await trailOf(h, {
      tabId: "tab-a",
      id: 3,
      key: "row",
      params: { id: "a" },
    });
    expect(t.request.kind).toBe("received");
    expect(t.queued).toMatchObject({ probe: false });
    expect(t.loading).toBeNull();
    expect(t.gate).toMatchObject({ active: 6, queued: 1, max: 6 });
    expect(t.gate.holders.map((x) => x.label).sort()).toEqual([
      `slow-a {"i":"0"}`,
      `slow-a {"i":"1"}`,
      `slow-a {"i":"2"}`,
      `slow-b {"i":"0"}`,
      `slow-b {"i":"1"}`,
      `slow-b {"i":"2"}`,
    ]);

    ctl.release();
    await tick();
    await tick();
    const after = await trailOf(h, {
      tabId: "tab-a",
      id: 3,
      key: "row",
      params: { id: "a" },
    });
    expect(after.request).toMatchObject({ kind: "answered", frame: "sub-ack" });
    expect(after.queued).toBeNull();
    expect(after.loading).toBeNull();
  });

  test("a read holding its slot while its loader waits: loading, and itself among the holders", async () => {
    const h = createHarness();
    const ctl = controllable("v");
    h.runtime.defineExternalResource<string, Record<string, never>>({
      key: "waits",
      mode: "push",
      schema: z.string(),
      loader: () => ctl.loader(),
    });
    ctl.block();
    await h.subscribe("waits", {}, { tabId: "tab-a", id: 1 });

    const t = await trailOf(h, { tabId: "tab-a", id: 1, key: "waits" });
    expect(t.request.kind).toBe("received");
    expect(t.queued).toBeNull();
    expect(t.loading).not.toBeNull();
    expect(t.gate.holders.map((x) => x.label)).toEqual(["waits"]);

    ctl.release();
    await tick();
    const after = await trailOf(h, { tabId: "tab-a", id: 1, key: "waits" });
    expect(after.request).toMatchObject({ kind: "answered", frame: "sub-ack" });
    expect(after.loading).toBeNull();
  });

  test("a batch's entries are each answered by the batch's up-to-date or their own sub-ack", async () => {
    const h = createHarness();
    h.runtime.defineExternalResource<string, Record<string, never>>({
      key: "v",
      mode: "push",
      schema: z.string(),
      loader: async () => "v",
    });
    await h.subscribeBatch([{ key: "v" }], { tabId: "tab-b" });
    const t = await trailOf(h, { tabId: "tab-b", id: 1, key: "v" });
    expect(t.request).toMatchObject({ kind: "answered", frame: "sub-ack" });
  });

  test("a malformed question is a 400, never a guess", async () => {
    const h = createHarness();
    const res = await h.runtime.handleResourceHttp(
      new Request("http://localhost/api/resources/_answer?tabId=a&id=x"),
      { key: "_answer" },
    );
    expect(res.status).toBe(400);
  });
});
