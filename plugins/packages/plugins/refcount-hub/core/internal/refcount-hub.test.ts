import { describe, expect, test } from "bun:test";
import { createRefcountHub, type HubStop } from "./refcount-hub";

/** Await `p` and return the Error it rejected with; throw if it resolved. */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

/** A sync source per key, counting opens and stops, with a handle to emit. */
function syncSource() {
  const life = { opens: 0, stops: 0 };
  const emitters = new Map<string, (n: number) => void>();
  const hub = createRefcountHub<number>((key, emit) => {
    life.opens++;
    emitters.set(key, emit);
    return () => {
      life.stops++;
      emitters.delete(key);
    };
  });
  return { hub, life, emit: (key: string, n: number) => emitters.get(key)!(n) };
}

/** An async source whose opens resolve (or fail) when the test says so. */
function asyncSource() {
  const life = { opens: 0, stops: 0 };
  const pending: {
    key: string;
    resolve: (stop: HubStop) => void;
    reject: (err: Error) => void;
  }[] = [];
  const emitters = new Map<string, (n: number) => void>();
  const hub = createRefcountHub<number>(
    (key, emit) =>
      new Promise<HubStop>((resolve, reject) => {
        life.opens++;
        emitters.set(key, emit);
        pending.push({ key, resolve, reject });
      }),
  );
  const stop: HubStop = () => {
    life.stops++;
  };
  return { hub, life, pending, stop, emitters };
}

describe("createRefcountHub — sync open", () => {
  test("holders of one key share one subscription; an event reaches each; the last release stops it", () => {
    const { hub, life, emit } = syncSource();
    const a: number[] = [];
    const b: number[] = [];
    const ha = hub.acquire("k", (n) => a.push(n));
    const hb = hub.acquire("k", (n) => b.push(n));
    expect(life.opens).toBe(1);
    emit("k", 1);
    expect(a).toEqual([1]);
    expect(b).toEqual([1]);
    ha.release();
    expect(life.stops).toBe(0);
    emit("k", 2);
    expect(a).toEqual([1]);
    expect(b).toEqual([1, 2]);
    hb.release();
    expect(life.stops).toBe(1);
    expect(hub.has("k")).toBe(false);
    hub.acquire("k", () => {});
    expect(life.opens).toBe(2);
  });

  test("keys are independent", () => {
    const { hub, life, emit } = syncSource();
    const a: number[] = [];
    hub.acquire("a", (n) => a.push(n));
    const hb = hub.acquire("b", () => {});
    expect(life.opens).toBe(2);
    emit("b", 1);
    expect(a).toEqual([]);
    hb.release();
    expect(hub.keys()).toEqual(["a"]);
  });

  test("a release is idempotent, and the same listener acquired twice is two holds", () => {
    const { hub, life, emit } = syncSource();
    let n = 0;
    const listener = () => n++;
    const h1 = hub.acquire("k", listener);
    const h2 = hub.acquire("k", listener);
    emit("k", 0);
    expect(n).toBe(2);
    h1.release();
    h1.release();
    expect(life.stops).toBe(0);
    h2.release();
    expect(life.stops).toBe(1);
  });

  test("a sync open that throws throws from acquire and holds nothing", () => {
    const hub = createRefcountHub<number>(() => {
      throw new Error("cannot open");
    });
    expect(() => hub.acquire("k", () => {})).toThrow("cannot open");
    expect(hub.has("k")).toBe(false);
  });

  test("every listener hears an event even when one throws; the throw surfaces", () => {
    const { hub, emit } = syncSource();
    const heard: string[] = [];
    hub.acquire("k", () => {
      heard.push("a");
      throw new Error("boom");
    });
    hub.acquire("k", () => heard.push("b"));
    expect(() => emit("k", 0)).toThrow("boom");
    expect(heard).toEqual(["a", "b"]);
  });

  test("a listener releasing during fan-out does not starve the others", () => {
    const { hub, emit } = syncSource();
    const heard: string[] = [];
    const ha = hub.acquire("k", () => {
      heard.push("a");
      ha.release();
    });
    hub.acquire("k", () => heard.push("b"));
    emit("k", 0);
    expect(heard).toEqual(["a", "b"]);
  });
});

describe("createRefcountHub — async open", () => {
  test("a second acquire while opening joins the in-flight open", async () => {
    const { hub, life, pending, stop } = asyncSource();
    const h1 = hub.acquire("k", () => {});
    const h2 = hub.acquire("k", () => {});
    expect(life.opens).toBe(1);
    expect(hub.has("k")).toBe(true);
    pending[0]!.resolve(stop);
    await Promise.all([h1.ready, h2.ready]);
    h1.release();
    h2.release();
    expect(life.stops).toBe(1);
  });

  test("a failed open rejects every joiner and is forgotten; the next acquire retries", async () => {
    const { hub, life, pending, stop } = asyncSource();
    const h1 = hub.acquire("k", () => {});
    const h2 = hub.acquire("k", () => {});
    pending[0]!.reject(new Error("no such dir"));
    expect((await rejection(h1.ready)).message).toBe("no such dir");
    expect((await rejection(h2.ready)).message).toBe("no such dir");
    expect(hub.has("k")).toBe(false);
    h1.release();
    const h3 = hub.acquire("k", () => {});
    expect(life.opens).toBe(2);
    pending[1]!.resolve(stop);
    await h3.ready;
    h3.release();
    expect(life.stops).toBe(1);
  });

  test("a last release while still opening stops the subscription once it opens", async () => {
    const { hub, life, pending, stop } = asyncSource();
    const h = hub.acquire("k", () => {});
    h.release();
    expect(hub.has("k")).toBe(false);
    expect(life.stops).toBe(0);
    pending[0]!.resolve(stop);
    await h.ready;
    expect(life.stops).toBe(1);
  });

  test("events emitted after the last release are dropped", async () => {
    const { hub, pending, stop, emitters } = asyncSource();
    const heard: number[] = [];
    const h = hub.acquire("k", (n) => heard.push(n));
    pending[0]!.resolve(stop);
    await h.ready;
    emitters.get("k")!(1);
    h.release();
    emitters.get("k")!(2);
    expect(heard).toEqual([1]);
  });
});
