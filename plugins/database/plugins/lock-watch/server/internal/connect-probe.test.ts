import { describe, expect, test } from "bun:test";
import { probeNewConnection } from "./connect-probe";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("probeNewConnection", () => {
  test("a connection that answers in time takes no look", async () => {
    const looks: number[] = [];
    await probeNewConnection({
      stallMs: 50,
      connect: () => Promise.resolve(),
      onStalled: (ms) => {
        looks.push(ms);
        return Promise.resolve();
      },
    });
    expect(looks).toEqual([]);
  });

  test("a stalled connection gets a look while it is still pending", async () => {
    const connect = deferred();
    let pendingAtLook = false;
    let settled = false;
    void connect.promise.then(() => (settled = true));
    await probeNewConnection({
      stallMs: 10,
      connect: () => connect.promise,
      onStalled: async (ms) => {
        expect(ms).toBe(10);
        pendingAtLook = !settled;
        connect.resolve();
      },
    });
    expect(pendingAtLook).toBe(true);
  });

  test("a connect that fails before the bound fails the probe, with no look", () => {
    const looks: number[] = [];
    expect(
      probeNewConnection({
        stallMs: 1_000,
        connect: () => Promise.reject(new Error("refused")),
        onStalled: (ms) => {
          looks.push(ms);
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow("refused");
    expect(looks).toEqual([]);
  });

  test("a stalled connect that then misses its deadline still fails loudly, after the look", () => {
    const connect = deferred();
    const looks: number[] = [];
    const probe = probeNewConnection({
      stallMs: 10,
      connect: () => connect.promise,
      onStalled: async (ms) => {
        looks.push(ms);
        connect.reject(new Error("no reply within 60000ms"));
      },
    });
    expect(probe).rejects.toThrow("no reply within 60000ms");
    expect(looks).toEqual([10]);
  });

  test("a failed look and a failed connect are both reported", () => {
    const connect = deferred();
    const probe = probeNewConnection({
      stallMs: 10,
      connect: () => connect.promise,
      onStalled: async () => {
        connect.reject(new Error("connect lost"));
        throw new Error("look lost");
      },
    });
    expect(probe).rejects.toThrow(
      "a new connection stalled, and the look at the cluster failed too",
    );
  });
});
