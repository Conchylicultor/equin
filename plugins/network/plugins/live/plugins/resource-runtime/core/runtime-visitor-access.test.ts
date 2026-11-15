/**
 * A deployed site's visitor reads only the resources declaring
 * `access: { visitor }` (`ResourceDefinition.access`) — on every read path:
 * a socket sub, a sub-batch entry, the HTTP read, and (for the boot snapshot,
 * outside this runtime) `visitorReadable`. The owner reads everything.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createHarness, tick } from "./test-support";

const VISITOR = { visitor: "the test page reads it" } as const;

function define(h: ReturnType<typeof createHarness>) {
  let loads = 0;
  h.runtime.defineExternalResource(
    {
      key: "open",
      schema: z.number(),
      validateParams: () => {},
      access: VISITOR,
    },
    { mode: "push", loader: async () => 1 },
  );
  h.runtime.defineExternalResource(
    { key: "closed", schema: z.number(), validateParams: () => {} },
    {
      mode: "push",
      loader: async () => {
        loads++;
        return 2;
      },
    },
  );
  return { loads: () => loads };
}

const get = (key: string) => new Request(`http://backend/api/resources/${key}`);

describe("visitor access — the socket", () => {
  test("a visitor's sub of an undeclared key is refused unauthorized, before any load", async () => {
    const h = createHarness({ principals: ["visitor"] });
    const c = define(h);
    await h.subscribe("closed", {}, { id: 7, tabId: "t" });
    const err = h.frames.find((f) => f.kind === "sub-error");
    expect(err).toMatchObject({ key: "closed", reason: "unauthorized", id: 7 });
    expect(h.frames.some((f) => f.kind === "sub-ack")).toBe(false);
    expect(c.loads()).toBe(0);
  });

  test("a visitor's sub of a declared key is answered", async () => {
    const h = createHarness({ principals: ["visitor"] });
    define(h);
    await h.subscribe("open");
    expect(h.frames.filter((f) => f.kind === "sub-ack")).toHaveLength(1);
    expect(h.frames.some((f) => f.kind === "sub-error")).toBe(false);
  });

  test("a visitor's sub-batch refuses each undeclared entry and answers the rest", async () => {
    const h = createHarness({ principals: ["visitor"] });
    const c = define(h);
    await h.subscribeBatch([{ key: "open" }, { key: "closed" }]);
    await tick();
    const errs = h.frames.filter((f) => f.kind === "sub-error");
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatchObject({ key: "closed", reason: "unauthorized" });
    expect(c.loads()).toBe(0);
    expect(
      h.frames.some(
        (f) =>
          (f.kind === "sub-ack" || f.kind === "up-to-date-batch") &&
          JSON.stringify(f).includes('"open"'),
      ),
    ).toBe(true);
  });

  test("the owner's socket — and one with no principal (a browser host) — reads every key", async () => {
    for (const principals of [["owner" as const], []]) {
      const h = createHarness({ principals });
      const c = define(h);
      await h.subscribe("closed");
      expect(h.frames.some((f) => f.kind === "sub-error")).toBe(false);
      expect(c.loads()).toBe(1);
    }
  });
});

describe("visitor access — HTTP", () => {
  test("a visitor gets 403 unauthorized on an undeclared key, 200 on a declared one", async () => {
    const h = createHarness({ callerOf: () => "visitor" });
    const c = define(h);
    const refused = await h.runtime.handleResourceHttp(get("closed"), {
      key: "closed",
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ reason: "unauthorized" });
    expect(c.loads()).toBe(0);
    const ok = await h.runtime.handleResourceHttp(get("open"), { key: "open" });
    expect(ok.status).toBe(200);
    expect((await ok.json()).value).toBe(1);
  });

  test("a visitor cannot read the runtime's diagnostics", async () => {
    const h = createHarness({ callerOf: () => "visitor" });
    define(h);
    const r = await h.runtime.handleResourceHttp(get("_debug"), {
      key: "_debug",
    });
    expect(r.status).toBe(403);
  });

  test("an unknown key is still 404 for a visitor", async () => {
    const h = createHarness({ callerOf: () => "visitor" });
    define(h);
    const r = await h.runtime.handleResourceHttp(get("nope"), { key: "nope" });
    expect(r.status).toBe(404);
  });

  test("without callerOf (central, a browser host) every read is the owner's", async () => {
    const h = createHarness();
    define(h);
    const r = await h.runtime.handleResourceHttp(get("closed"), {
      key: "closed",
    });
    expect(r.status).toBe(200);
  });
});

describe("visitorReadable", () => {
  test("only a registered key declaring access is visitor-readable", () => {
    const h = createHarness();
    define(h);
    expect(h.runtime.visitorReadable("open")).toBe(true);
    expect(h.runtime.visitorReadable("closed")).toBe(false);
    expect(h.runtime.visitorReadable("nope")).toBe(false);
  });
});

describe("visitor access — nothing of an owner-only key leaks", () => {
  test("access is checked before the params gate: a visitor's bad params on an owner-only key are unauthorized, never a contract verdict", async () => {
    const h = createHarness({ principals: ["visitor"] });
    h.runtime.defineExternalResource(
      {
        key: "strict",
        schema: z.number(),
        validateParams: () => {
          throw new Error("the params gate must not run for a refused caller");
        },
      },
      { mode: "push", loader: async () => 1 },
    );
    await h.subscribe("strict", { bogus: "x" });
    await h.subscribeBatch([{ key: "strict", params: { bogus: "y" } }]);
    const errs = h.frames.filter((f) => f.kind === "sub-error");
    expect(errs).toHaveLength(2);
    for (const e of errs) expect(e.reason).toBe("unauthorized");
  });

  test("a visitor naming the owner's tab id releases none of the owner's lingering subs", async () => {
    const h = createHarness({
      sockets: 3,
      principals: ["owner", "visitor", "owner"],
    });
    define(h);
    const linger = async () =>
      (
        (await (
          await h.runtime.handleResourceHttp(get("_debug"), { key: "_debug" })
        ).json()) as { linger: { sockets: number; records: number } }
      ).linger;
    await h.subscribe("closed", {}, { socket: 0, tabId: "owner-tab" });
    h.closeSocket(0); // the owner's subs linger, awaiting the tab's replay
    expect(await linger()).toMatchObject({ sockets: 1, records: 1 });
    await h.unsubTab("owner-tab", { socket: 1 }); // a visitor's socket
    expect(await linger()).toMatchObject({ sockets: 1, records: 1 });
    await h.unsubTab("owner-tab", { socket: 2 }); // the owner's own
    expect(await linger()).toMatchObject({ sockets: 0, records: 0 });
  });
});
