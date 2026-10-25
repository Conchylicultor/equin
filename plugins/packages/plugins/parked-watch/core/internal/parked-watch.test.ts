import { describe, expect, test } from "bun:test";
import { createParkedWatches } from "./parked-watch";

/** A promise and its resolver, to hold a resolve or an open in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/**
 * Await `p` and return the Error it rejected with; throw if it resolved.
 * `expect(p).rejects.toThrow()` is typed `void` under bun:test, so awaiting it
 * trips await-thenable.
 */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

// A parked open that fails reports here; a test that expects none fails loudly.
const failOnOpenError = {
  onOpenError: (key: string, err: unknown) => {
    throw new Error(`unexpected open failure on ${key}: ${String(err)}`);
  },
};

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** An `open` that records each target it opened and each stop it ran. */
function opener() {
  const opened: string[] = [];
  const stopped: string[] = [];
  const open = (target: string) => {
    opened.push(target);
    return Promise.resolve(() => void stopped.push(target));
  };
  return { open, opened, stopped };
}

describe("createParkedWatches", () => {
  test("a target found at subscribe opens at once, with no extra notify", async () => {
    const parked = createParkedWatches<string>(failOnOpenError);
    const { open, opened, stopped } = opener();
    let changes = 0;
    const stop = await parked.watch(
      "c1",
      () => Promise.resolve("/wt"),
      open,
      () => changes++,
    );
    expect(opened).toEqual(["/wt"]);
    expect(changes).toBe(0);
    // Nothing stays parked: a later load opens nothing more.
    parked.resolved("c1", "/wt");
    await flush();
    expect(opened).toEqual(["/wt"]);
    stop();
    expect(stopped).toEqual(["/wt"]);
  });

  test("no target yet parks the watch; the first load that resolves it opens it, then notifies", async () => {
    const parked = createParkedWatches<string>(failOnOpenError);
    const { open, opened, stopped } = opener();
    let changes = 0;
    const stop = await parked.watch(
      "c1",
      () => Promise.resolve(null),
      open,
      () => changes++,
    );
    expect(opened).toEqual([]);
    // Another key's load opens nothing.
    parked.resolved("c2", "/other");
    await flush();
    expect(opened).toEqual([]);
    parked.resolved("c1", "/wt");
    await flush();
    expect(opened).toEqual(["/wt"]);
    expect(changes).toBe(1);
    // A second load finds it already open.
    parked.resolved("c1", "/wt");
    await flush();
    expect(opened).toEqual(["/wt"]);
    stop();
    expect(stopped).toEqual(["/wt"]);
  });

  test("a load resolving the target while the subscribe's own resolve is in flight opens the watch (the row inserted mid-subscribe)", async () => {
    const parked = createParkedWatches<string>(failOnOpenError);
    const { open, opened } = opener();
    let changes = 0;
    const now = deferred<string | null>();
    const watching = parked.watch(
      "c1",
      () => now.promise,
      open,
      () => changes++,
    );
    // The subscribe's read ran before the insert; the insert's load runs first.
    parked.resolved("c1", "/wt");
    now.resolve(null);
    await watching;
    await flush();
    expect(opened).toEqual(["/wt"]);
    expect(changes).toBe(1);
  });

  test("a target found both by a load and by the subscribe opens once", async () => {
    const parked = createParkedWatches<string>(failOnOpenError);
    const { open, opened } = opener();
    const now = deferred<string | null>();
    const watching = parked.watch(
      "c1",
      () => now.promise,
      open,
      () => {},
    );
    parked.resolved("c1", "/wt");
    now.resolve("/wt");
    await watching;
    await flush();
    expect(opened).toEqual(["/wt"]);
  });

  test("a stop before the parked watch opens closes it as soon as it opens, and notifies nobody", async () => {
    const parked = createParkedWatches<string>(failOnOpenError);
    const opening = deferred<() => void>();
    let closed = 0;
    let changes = 0;
    const stop = await parked.watch(
      "c1",
      () => Promise.resolve(null),
      () => opening.promise,
      () => changes++,
    );
    parked.resolved("c1", "/wt");
    stop();
    opening.resolve(() => closed++);
    await flush();
    expect(closed).toBe(1);
    expect(changes).toBe(0);
  });

  test("a stopped watch is no longer parked", async () => {
    const parked = createParkedWatches<string>(failOnOpenError);
    const { open, opened } = opener();
    const stop = await parked.watch(
      "c1",
      () => Promise.resolve(null),
      open,
      () => {},
    );
    stop();
    parked.resolved("c1", "/wt");
    await flush();
    expect(opened).toEqual([]);
  });

  test("a failed subscribe resolve rejects and leaves nothing parked", async () => {
    const parked = createParkedWatches<string>(failOnOpenError);
    const { open, opened } = opener();
    const err = await rejection(
      parked.watch(
        "c1",
        () => Promise.reject(new Error("no git here")),
        open,
        () => {},
      ),
    );
    expect(err.message).toBe("no git here");
    parked.resolved("c1", "/wt");
    await flush();
    expect(opened).toEqual([]);
  });

  test("a parked open that fails is reported and parked again: the next resolving load retries it", async () => {
    const failures: [string, string][] = [];
    const parked = createParkedWatches<string>({
      onOpenError: (key, err) =>
        void failures.push([key, (err as Error).message]),
    });
    const opened: string[] = [];
    let attempts = 0;
    let changes = 0;
    const stop = await parked.watch(
      "c1",
      () => Promise.resolve(null),
      (target) => {
        attempts++;
        if (attempts === 1) return Promise.reject(new Error("EMFILE"));
        opened.push(target);
        return Promise.resolve(() => {});
      },
      () => changes++,
    );
    parked.resolved("c1", "/wt");
    await flush();
    expect(failures).toEqual([["c1", "EMFILE"]]);
    // A failure notifies nobody: a loader re-run would retry it at once.
    expect(changes).toBe(0);
    expect(opened).toEqual([]);
    parked.resolved("c1", "/wt");
    await flush();
    expect(opened).toEqual(["/wt"]);
    expect(changes).toBe(1);
    expect(failures).toHaveLength(1);
    stop();
  });

  test("a parked open that fails after its stop is reported and not parked again", async () => {
    const failures: string[] = [];
    const parked = createParkedWatches<string>({
      onOpenError: (key) => void failures.push(key),
    });
    let attempts = 0;
    let reject!: (err: Error) => void;
    const stop = await parked.watch(
      "c1",
      () => Promise.resolve(null),
      () => {
        attempts++;
        return new Promise<() => void>((_, r) => (reject = r));
      },
      () => {},
    );
    parked.resolved("c1", "/wt");
    stop();
    reject(new Error("gone"));
    await flush();
    expect(failures).toEqual(["c1"]);
    parked.resolved("c1", "/wt");
    await flush();
    expect(attempts).toBe(1);
  });

  test("an open that fails at subscribe rejects the subscribe and reports nothing", async () => {
    const failures: string[] = [];
    const parked = createParkedWatches<string>({
      onOpenError: (key) => void failures.push(key),
    });
    const err = await rejection(
      parked.watch(
        "c1",
        () => Promise.resolve("/wt"),
        () => Promise.reject(new Error("EMFILE")),
        () => {},
      ),
    );
    expect(err.message).toBe("EMFILE");
    expect(failures).toEqual([]);
  });
});
