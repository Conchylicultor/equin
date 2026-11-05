/**
 * The read-admission gate (READ_LOAD_CONCURRENCY) drops a subscription's read
 * that reaches its slot after every subscriber of the tuple left
 * (`ReadAbandoned`), names who holds its slots (`readGateStats().holders`),
 * and times a tuple's watcher start as its own `sub start:<key>` span.
 *
 * From task-1793837504-f7ona7: a tab scrolling a per-row list queues one cold
 * read per row (the file explorer's `host-fs.peek`, `reports.list:rows` per
 * id), unsubscribes most of them within seconds, and every other tab's subs
 * still waited behind loads nobody would receive.
 */

import { test, expect, describe } from "bun:test";
import { z } from "zod";
import {
  createHarness,
  controllable,
  tick,
  type Harness,
} from "./test-support";

/**
 * Six parked reads: two keys (`slow-a`, `slow-b`), each at its share of three
 * — every read-admission slot held.
 */
function fillGate(h: Harness) {
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
  return {
    ctl,
    async fill() {
      for (const key of ["slow-a", "slow-b"])
        for (let i = 0; i < 3; i++) await h.subscribe(key, { i: String(i) });
      expect(h.runtime.readGateStats().active).toBe(6);
    },
  };
}

async function abandonedReadsOf(h: Harness, key: string): Promise<number> {
  const res = await h.runtime.handleResourceHttp(
    new Request("http://localhost/api/resources/_debug"),
    { key: "_debug" },
  );
  const body = (await res.json()) as {
    resources: Array<{ key: string; abandonedReads: number }>;
  };
  return body.resources.find((r) => r.key === key)!.abandonedReads;
}

function defineRow(h: Harness, onLoad: () => void, revalidate?: () => void) {
  h.runtime.defineExternalResource<string, { id: string }>({
    key: "row",
    mode: "push",
    schema: z.string(),
    loader: async ({ id }) => {
      onLoad();
      return `row ${id}`;
    },
    ...(revalidate && {
      revalidate: async () => {
        revalidate();
        return "sig";
      },
    }),
  });
}

describe("read-admission: a queued read nobody holds any more", () => {
  test("is dropped at its slot: no loader run, no frame", async () => {
    const h = createHarness();
    const gate = fillGate(h);
    let loads = 0;
    defineRow(h, () => loads++);
    await gate.fill();

    await h.subscribe("row", { id: "a" });
    expect(h.runtime.readGateStats().queued).toBe(1);
    await h.unsub("row", { id: "a" });

    gate.ctl.release();
    await tick();
    await tick();
    expect(loads).toBe(0);
    expect(h.frames.filter((f) => f.key === "row")).toEqual([]);
    expect(h.runtime.readGateStats()).toMatchObject({ active: 0, queued: 0 });
    expect(await abandonedReadsOf(h, "row")).toBe(1);
  });

  test("its signature probe is dropped too: neither revalidate nor the loader runs", async () => {
    const h = createHarness();
    const gate = fillGate(h);
    let loads = 0;
    let probes = 0;
    defineRow(
      h,
      () => loads++,
      () => probes++,
    );
    await gate.fill();

    await h.subscribe("row", { id: "a" });
    await h.unsub("row", { id: "a" });
    gate.ctl.release();
    await tick();
    await tick();
    expect(probes).toBe(0);
    expect(loads).toBe(0);
    expect(h.frames.filter((f) => f.key === "row")).toEqual([]);
  });

  test("still runs while another socket holds the tuple, and answers it", async () => {
    const h = createHarness({ sockets: 2 });
    const gate = fillGate(h);
    let loads = 0;
    defineRow(h, () => loads++);
    await gate.fill();

    await h.subscribe("row", { id: "a" }, { socket: 0 });
    await h.subscribe("row", { id: "a" }, { socket: 1 }); // joins the flight
    await h.unsub("row", { id: "a" }, { socket: 0 });

    gate.ctl.release();
    await tick();
    await tick();
    expect(loads).toBe(1);
    const acks = h.frames.filter(
      (f) => f.key === "row" && f.kind === "sub-ack",
    );
    expect(acks.map((f) => f.socket).sort()).toEqual([0, 1]);
    expect(await abandonedReadsOf(h, "row")).toBe(0);
  });

  test("still runs for an HTTP read that joined the flight", async () => {
    const h = createHarness();
    const gate = fillGate(h);
    let loads = 0;
    defineRow(h, () => loads++);
    await gate.fill();

    await h.subscribe("row", { id: "a" });
    const http = h.runtime.handleResourceHttp(
      new Request("http://localhost/api/resources/row?id=a"),
      { key: "row" },
    );
    await tick();
    await h.unsub("row", { id: "a" });

    gate.ctl.release();
    const res = await http;
    expect(res.status).toBe(200);
    expect(((await res.json()) as { value: string }).value).toBe("row a");
    expect(loads).toBe(1);
  });

  test("a tuple subscribed again before its slot comes is read once, for the new holder", async () => {
    const h = createHarness();
    const gate = fillGate(h);
    let loads = 0;
    defineRow(h, () => loads++);
    await gate.fill();

    await h.subscribe("row", { id: "a" });
    await h.unsub("row", { id: "a" });
    await h.subscribe("row", { id: "a" }); // joins the still-queued flight

    gate.ctl.release();
    await tick();
    await tick();
    expect(loads).toBe(1);
    expect(
      h.frames.filter((f) => f.key === "row" && f.kind === "sub-ack"),
    ).toHaveLength(2);
  });
});

describe("read-admission: who holds the slots", () => {
  test("readGateStats().holders names each running read by key and params", async () => {
    const h = createHarness();
    const gate = fillGate(h);
    let loads = 0;
    defineRow(h, () => loads++);
    await gate.fill();
    await h.subscribe("row", { id: "a" }); // queued: holds nothing

    const { holders } = h.runtime.readGateStats();
    expect(holders).toHaveLength(6);
    expect(holders.every((x) => /^slow-[ab] \{/.test(x.label))).toBe(true);
    expect(new Set(holders.map((x) => x.label)).size).toBe(6);

    gate.ctl.release();
    await tick();
    await tick();
    expect(h.runtime.readGateStats().holders).toEqual([]);
  });
});

describe("a tuple's watcher start", () => {
  test("runs as its own `sub start:<key>` span before the read", async () => {
    const spans: string[] = [];
    const h = createHarness({
      wrapOrigin: async (kind, key, fn) => {
        spans.push(`${kind} ${key}`);
        return fn();
      },
    });
    h.runtime.defineExternalResource({
      key: "watched",
      mode: "push",
      schema: z.string(),
      loader: async () => "v",
      onFirstSubscribe: async () => {},
    });
    await h.subscribe("watched");
    expect(spans).toEqual(["sub start:watched", "sub watched"]);
  });
});

describe("read-admission: one key's share", () => {
  test("a key holds at most half the slots; its other reads are passed over while other keys run", async () => {
    const h = createHarness();
    const hung = controllable("v");
    h.runtime.defineExternalResource<string, { path: string }>({
      key: "peek",
      mode: "push",
      schema: z.string(),
      loader: () => hung.loader(),
    });
    let rows = 0;
    defineRow(h, () => rows++);
    hung.block();

    // One tab's per-row reads of a hung key: 15 of them.
    for (let i = 0; i < 15; i++)
      await h.subscribe("peek", { path: `/tmp/${i}` });
    expect(h.runtime.readGateStats()).toMatchObject({ active: 3, queued: 12 });

    // Another key is admitted at once, never queued behind them.
    await h.subscribe("row", { id: "a" });
    await tick();
    expect(rows).toBe(1);
    expect(
      h.frames.filter((f) => f.key === "row" && f.kind === "sub-ack"),
    ).toHaveLength(1);

    hung.release();
    await tick();
    await tick();
    expect(
      h.frames.filter((f) => f.key === "peek" && f.kind === "sub-ack"),
    ).toHaveLength(15);
    expect(h.runtime.readGateStats()).toMatchObject({ active: 0, queued: 0 });
  });
});

describe("read-admission: an abandoned flight is not joined", () => {
  test("a sub arriving after its tuple's queued read was dropped gets a fresh read and an answer", async () => {
    const h = createHarness({ sockets: 2 });
    const gate = fillGate(h);
    let loads = 0;
    defineRow(h, () => loads++);
    await gate.fill();

    await h.subscribe("row", { id: "a" }, { socket: 0 });
    await h.unsub("row", { id: "a" }, { socket: 0 });
    gate.ctl.release();
    await tick();
    await tick();
    expect(loads).toBe(0);

    await h.subscribe("row", { id: "a" }, { socket: 1 });
    await tick();
    expect(loads).toBe(1);
    expect(
      h.frames.filter(
        (f) => f.key === "row" && f.kind === "sub-ack" && f.socket === 1,
      ),
    ).toHaveLength(1);
  });
});
