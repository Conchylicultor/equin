import { describe, expect, test } from "bun:test";
import { SchemaNotReadyError } from "@plugins/framework/plugins/server-core/core";
import type { SchemaLayerCheck } from "@plugins/database/plugins/migrations/server";
import { waitForOwner, type OwnerWaitDeps } from "./await-schema-layer";
import type { ListenHandlers, OwnerBootRecord } from "./driver";

const NOT_READY = {
  kind: "not-ready",
  detail: "1 of this code's migrations are not applied (x.sql)",
} as const satisfies SchemaLayerCheck;

/**
 * A host whose owner, builds and deploys the test drives: `stamp()` records
 * this code's stamp and NOTIFYs; `settle()` ends the builds and deploys in
 * flight (as many as `waitedOn` names).
 */
function fakeHost(opts: {
  inFlight: boolean;
  /** The watch answers that no deploy will ever set up this code (an old main slot). */
  superseded?: string;
  lastOwnerBoot?: OwnerBootRecord | null;
}) {
  let ready = false;
  let handlers: ListenHandlers | null = null;
  let settle: (() => void) | null = null;
  let reads = 0;
  let closed = false;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const deps: OwnerWaitDeps = {
    verify: () => {
      reads++;
      return Promise.resolve(ready ? { kind: "ready" } : NOT_READY);
    },
    waitMs: 10 * 60 * 1000,
    driver: {
      listen: (name, _channels, h) => {
        expect(name).toBe("schema-wait");
        handlers = h;
        return Promise.resolve({
          close: () => {
            closed = true;
            return Promise.resolve();
          },
        });
      },
      awaitDeploysSettled: async (signal) => {
        if (opts.superseded !== undefined)
          return { kind: "superseded", detail: opts.superseded };
        if (!opts.inFlight) return { kind: "settled", waitedOn: [] };
        await new Promise<void>((resolve, reject) => {
          void settled.then(resolve);
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
        return { kind: "settled", waitedOn: ["a deploy of this namespace"] };
      },
      lastOwnerBoot: () => Promise.resolve(opts.lastOwnerBoot ?? null),
    },
  };
  return {
    deps,
    reads: () => reads,
    closed: () => closed,
    stamp() {
      ready = true;
      handlers?.notification("schema_layer_stamped", "stamp");
    },
    settle: () => settle?.(),
  };
}

/** Let every pending microtask and I/O callback run. */
const tick = () => new Promise((r) => setTimeout(r, 5));

describe("waitForOwner", () => {
  test("no build or deploy in flight: refused at once, naming the build", async () => {
    // The worktree whose checkout is ahead of its backend (unbuilt edits).
    const host = fakeHost({ inFlight: false });
    const started = Date.now();
    let caught: unknown;
    try {
      await waitForOwner(NOT_READY, host.deps);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SchemaNotReadyError);
    expect(String(caught)).toContain(
      "no build, deploy or backend boot of this checkout is in flight",
    );
    expect(String(caught)).toContain("./equin build");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(host.closed()).toBe(true);
  });

  test("a main slot main moved past: refused at once, naming why — never waits on main's next deploys", async () => {
    // report-1794960565-yv4ch2: a child the draining backend spawned from
    // its old slot waited the whole bound while newer deploys ran.
    const host = fakeHost({
      inFlight: true,
      superseded: "main has moved past this slot",
    });
    const started = Date.now();
    let caught: unknown;
    try {
      await waitForOwner(NOT_READY, host.deps);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SchemaNotReadyError);
    expect(String(caught)).toContain("main has moved past this slot");
    expect(String(caught)).not.toContain("./equin build");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(host.closed()).toBe(true);
  });

  test("a deploy in flight that records this code's stamp: the wait resolves on its NOTIFY", async () => {
    // Main's deploy window: the new backend boots and records the stamp.
    const host = fakeHost({ inFlight: true });
    const waiting = waitForOwner(NOT_READY, host.deps);
    await tick();
    expect(host.reads()).toBe(1);
    host.stamp();
    await waiting;
    expect(host.closed()).toBe(true);
  });

  test("the deploy recorded the stamp before the wait was armed: the read after it settles admits", async () => {
    const host = fakeHost({ inFlight: true });
    const waiting = waitForOwner(NOT_READY, host.deps);
    await tick();
    // Stamped with no NOTIFY reaching this session, then the deploy ended.
    host.stamp();
    host.settle();
    await waiting;
  });

  test("a deploy in flight that ends without setting it up: refused once it ends", async () => {
    // A deploy that failed, or built other code than this child's.
    const host = fakeHost({ inFlight: true });
    const waiting = waitForOwner(NOT_READY, host.deps);
    await tick();
    host.settle();
    let caught: unknown;
    try {
      await waiting;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SchemaNotReadyError);
    expect(String(caught)).toContain(
      "a deploy of this namespace ended without setting it up",
    );
    expect(host.closed()).toBe(true);
  });

  test("a deploy that never ends: refused at the bound", async () => {
    const host = fakeHost({ inFlight: true });
    let caught: unknown;
    try {
      await waitForOwner(NOT_READY, { ...host.deps, waitMs: 30 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SchemaNotReadyError);
    expect(host.closed()).toBe(true);
  });

  test("the last backend failed to record its stamp: refused naming that failure, not a build", async () => {
    // database's onReady: the stamp write threw; the backend serves on.
    const host = fakeHost({
      inFlight: true,
      lastOwnerBoot: {
        kind: "stamp-failed",
        pid: 4242,
        startedAt: Date.UTC(2026, 10, 15, 10, 0, 0),
        error: 'relation "schema_layer_stamps" does not exist',
      },
    });
    const waiting = waitForOwner(NOT_READY, host.deps);
    await tick();
    host.settle();
    let caught: unknown;
    try {
      await waiting;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SchemaNotReadyError);
    const message = String(caught);
    expect(message).toContain(
      "the serving backend that booted at 2026-11-15T10:00:00.000Z (pid 4242) failed to record its schema stamp",
    );
    expect(message).toContain('relation "schema_layer_stamps" does not exist');
    expect(message).toContain("server error of database's onReady");
    expect(message).not.toContain("./equin build");
  });

  test("the last backend exited before its stamp: refused naming the exit", async () => {
    const host = fakeHost({
      inFlight: false,
      lastOwnerBoot: { kind: "booting", pid: 7, startedAt: 0 },
    });
    let caught: unknown;
    try {
      await waitForOwner(NOT_READY, host.deps);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SchemaNotReadyError);
    expect(String(caught)).toContain(
      "exited before it recorded its schema stamp",
    );
  });

  test("the last backend recorded its stamp (for other code): refused naming the build", async () => {
    const host = fakeHost({
      inFlight: false,
      lastOwnerBoot: { kind: "recorded", pid: 7, startedAt: 0 },
    });
    let caught: unknown;
    try {
      await waitForOwner(NOT_READY, host.deps);
    } catch (err) {
      caught = err;
    }
    expect(String(caught)).toContain("./equin build");
  });
});
