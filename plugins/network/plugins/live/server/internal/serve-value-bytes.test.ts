/**
 * `bytes` values — a binary payload read on demand over HTTP. The type half
 * (what a bytes declaration refuses, and that a db arm cannot serve one) is
 * asserted with `@ts-expect-error` in never-called closures; the runtime half
 * through a real `createResourceRuntime`: the ArrayBuffer round-trips as
 * `application/octet-stream` with its envelope in headers, an unchanged
 * `revalidate` answers 304, and a payload past `maxBytes` is refused
 * `"too-large"`.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createResourceRuntime } from "@plugins/framework/plugins/resource-runtime/core";
import { liveValue } from "@plugins/network/plugins/live/core";
import { parseResourceBytesHeaders } from "@plugins/packages/plugins/resource-protocol/core";
import { compileValue, registerValue } from "../../core/internal/compile-value";
import { serveValue } from "./serve-value";

let seq = 0;
const key = (name: string) => `test.serve-value-bytes.${name}.${seq++}`;

const bytesOf = (...b: number[]) => new Uint8Array(b).buffer;

const NOTIFIED = "notified" as const;

describe("bytes — types", () => {
  test("a bytes declaration refuses push, preload, paged, central and a schema", () => {
    const push = { bytes: true, params: ["p"], load: "push" } as const;
    const snap = { bytes: true, params: ["p"], load: "snapshot" } as const;
    const preload = { bytes: true, params: ["p"], preload: "boot" } as const;
    const paged = {
      bytes: true,
      query: z.object({ q: z.string() }),
      paged: { item: z.object({ id: z.string() }), id: "id", limit: 5 },
    } as const;
    const central = { bytes: true, params: ["p"], origin: "central" } as const;
    const schema = { bytes: true, params: ["p"], schema: z.string() } as const;
    const typeOnly = () => {
      // @ts-expect-error — a bytes value is read on demand, never pushed
      liveValue(key("push"), push);
      // @ts-expect-error — nor a snapshot
      liveValue(key("snap"), snap);
      // @ts-expect-error — a boot snapshot is JSON
      liveValue(key("preload"), preload);
      // @ts-expect-error — a page is JSON
      liveValue(key("paged"), paged);
      // @ts-expect-error — a bytes value is a worktree one
      liveValue(key("central"), central);
      // @ts-expect-error — its schema is derived (an ArrayBuffer)
      liveValue(key("schema"), schema);
    };
    expect(typeof typeOnly).toBe("function");
  });

  test("a bytes value is served external only, its loader answering an ArrayBuffer", () => {
    const v = liveValue(key("db"), { bytes: true, params: ["path"] });
    const typeOnly = () => {
      // @ts-expect-error — a Postgres row is not a binary payload
      serveValue(v, { source: "db", loader: () => bytesOf(1) });
      // @ts-expect-error — …through the compile helper too
      compileValue(v, { source: "db", loader: () => bytesOf(1) });
      const text = {
        source: "external",
        changes: NOTIFIED,
        loader: () => "text",
      } as const;
      // @ts-expect-error — the payload is an ArrayBuffer, not a string
      serveValue(v, text);
    };
    expect(typeof typeOnly).toBe("function");
    const served = serveValue(v, {
      source: "external",
      changes: NOTIFIED,
      loader: () => bytesOf(1),
    });
    expect(typeof served.notify).toBe("function");
  });

  test("refusals: maxBytes adds too-large; refuse is typed by the result", () => {
    const bounded = liveValue(key("bounded"), {
      bytes: true,
      params: ["path"],
      maxBytes: 8,
      refusals: ["missing"],
    });
    expect(bounded.refusals).toEqual(["missing", "too-large"]);
    const r: "missing" | "too-large" = bounded.refusals[0]!;
    expect(r).toBe("missing");
    const unbounded = liveValue(key("unbounded"), {
      bytes: true,
      params: ["path"],
    });
    expect(unbounded.refusals).toBeUndefined();
    const typeOnly = () => {
      // @ts-expect-error — undeclared code
      bounded.refuse("denied", "no");
      // @ts-expect-error — no refusals declared, nothing to refuse with
      unbounded.refuse("too-large", "x");
    };
    expect(typeof typeOnly).toBe("function");
  });
});

describe("bytes — declaration", () => {
  test("derives an ArrayBuffer schema, forces on-demand, and brands the descriptor", () => {
    const v = liveValue(key("decl"), {
      bytes: true,
      params: ["path"],
      maxBytes: 1024,
    });
    expect(v).toMatchObject({
      bytes: true,
      load: "on-demand",
      maxBytes: 1024,
      params: ["path"],
      refusals: ["too-large"],
    });
    expect(v.schema.parse(bytesOf(1, 2))).toBeInstanceOf(ArrayBuffer);
    expect(() => v.schema.parse(new Uint8Array(2))).toThrow();
    expect(() => v.schema.parse("ab")).toThrow();
    const q = liveValue(key("decl-q"), {
      bytes: true,
      query: z.object({ path: z.string() }),
      refusals: z.enum(["missing"]),
    });
    expect(q).toMatchObject({
      bytes: true,
      load: "on-demand",
      params: ["q"],
      refusals: ["missing"],
    });
    const typed = liveValue(key("decl-typed"), {
      bytes: true,
      params: { kind: z.enum(["a", "b"]) },
    });
    expect(typed).toMatchObject({ bytes: true, params: ["kind"] });
  });

  test("an untyped caller is refused every combination tsc refuses", () => {
    const untyped = liveValue as (k: string, s: unknown) => unknown;
    const bad: [Record<string, unknown>, RegExp][] = [
      [{ bytes: true, params: ["p"], load: "push" }, /load: "push"/],
      [{ bytes: true, params: ["p"], preload: "boot" }, /preload/],
      [{ bytes: true, params: ["p"], origin: "central" }, /origin/],
      [{ bytes: true, params: ["p"], schema: z.string() }, /schema/],
      [
        {
          bytes: true,
          query: z.object({}),
          paged: { item: z.object({}), id: "id", limit: 1 },
        },
        /paged/,
      ],
      [{ bytes: true }, /no `params` or `query`/],
      [{ bytes: true, params: ["p"], maxBytes: 0 }, /maxBytes 0/],
      [{ bytes: "yes", schema: z.string() }, /`bytes` is `true` or absent/],
    ];
    for (const [spec, message] of bad) {
      expect(() => untyped(key("bad"), spec)).toThrow(message);
    }
  });

  test("a db serve of a bytes value throws for an untyped caller", () => {
    const v = liveValue(key("db-untyped"), { bytes: true, params: ["p"] });
    const untypedServe = serveValue as (v: unknown, o: unknown) => unknown;
    expect(() =>
      untypedServe(v, { source: "db", loader: () => bytesOf(1) }),
    ).toThrow(/a bytes value is served `source: "external"`/);
  });
});

describe("bytes — HTTP read", () => {
  const read = (
    runtime: ReturnType<typeof createResourceRuntime>,
    k: string,
    params: Record<string, string>,
    headers: Record<string, string> = {},
  ) =>
    runtime.handleResourceHttp(
      new Request(
        `http://x/api/resources/${k}?${new URLSearchParams(params).toString()}`,
        { headers },
      ),
      { key: k },
    );

  test("round-trips the ArrayBuffer as octet-stream, the envelope in headers", async () => {
    const runtime = createResourceRuntime();
    const v = liveValue(key("rt"), { bytes: true, params: ["path"] });
    const { resource } = registerValue(runtime, v, {
      source: "external",
      changes: NOTIFIED,
      loader: ({ path }) => new TextEncoder().encode(`<${path}>`).buffer,
    });
    expect(resource.mode).toBe("invalidate");
    const res = await read(runtime, v.key, { path: "a.png" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const envelope = parseResourceBytesHeaders(v.key, res.headers);
    expect(envelope.version).toBe(0);
    expect(envelope.epoch.length).toBeGreaterThan(0);
    const body = await res.arrayBuffer();
    expect(new TextDecoder().decode(body)).toBe("<a.png>");
  });

  test("an unchanged revalidate answers 304, a changed one the new bytes", async () => {
    const runtime = createResourceRuntime();
    const v = liveValue(key("etag"), { bytes: true, params: ["path"] });
    let generation = 1;
    let runs = 0;
    registerValue(runtime, v, {
      source: "external",
      changes: NOTIFIED,
      loader: () => {
        runs++;
        return bytesOf(generation);
      },
      revalidate: async () => `g${generation}`,
    });
    const first = await read(runtime, v.key, { path: "p" });
    const etag = first.headers.get("ETag")!;
    expect(etag).not.toBeNull();
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(
      new Uint8Array([1]),
    );
    const unchanged = await read(
      runtime,
      v.key,
      { path: "p" },
      {
        "If-None-Match": etag,
      },
    );
    expect(unchanged.status).toBe(304);
    expect(runs).toBe(1);
    generation = 2;
    const changed = await read(
      runtime,
      v.key,
      { path: "p" },
      {
        "If-None-Match": etag,
      },
    );
    expect(changed.status).toBe(200);
    expect(changed.headers.get("ETag")).not.toBe(etag);
    expect(new Uint8Array(await changed.arrayBuffer())).toEqual(
      new Uint8Array([2]),
    );
  });

  test("a payload past maxBytes is refused too-large; one at it is served", async () => {
    const runtime = createResourceRuntime();
    const v = liveValue(key("max"), {
      bytes: true,
      params: ["size"],
      maxBytes: 4,
    });
    registerValue(runtime, v, {
      source: "external",
      changes: NOTIFIED,
      loader: ({ size }) => new ArrayBuffer(Number(size)),
    });
    const ok = await read(runtime, v.key, { size: "4" });
    expect(ok.status).toBe(200);
    expect((await ok.arrayBuffer()).byteLength).toBe(4);
    const over = await read(runtime, v.key, { size: "5" });
    expect(over.status).toBe(422);
    expect(await over.json()).toEqual({
      reason: "refused",
      code: "too-large",
      detail: expect.stringContaining("over the 4-byte limit"),
    });
  });

  test("a loader answering something other than an ArrayBuffer fails loudly", async () => {
    const runtime = createResourceRuntime({ reportError: () => {} });
    const v = liveValue(key("wrong"), { bytes: true, params: ["p"] });
    registerValue(runtime, v, {
      source: "external",
      changes: NOTIFIED,
      loader: () => new Uint8Array(3) as unknown as ArrayBuffer,
    });
    const res = await read(runtime, v.key, { p: "x" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ reason: "loader-failed" });
  });
});
