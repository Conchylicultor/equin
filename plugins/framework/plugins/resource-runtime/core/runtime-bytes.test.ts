/**
 * Bytes resources (`ResourceDefinition.bytes`) — a value that is an
 * ArrayBuffer and never rides a JSON frame. Pins:
 *   - the HTTP read answers `application/octet-stream`, the body the value,
 *     the envelope (version, epoch) in response headers, the ETag as for any
 *     read, and a 304 on an unchanged `revalidate`;
 *   - the WS sub-ack carries no value (and no etag), runs no loader, and still
 *     reports the tuple's version and the boot epoch;
 *   - a notify sends an `invalidate` frame;
 *   - a bytes resource is mode `invalidate` only.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { parseResourceBytesHeaders } from "@plugins/packages/plugins/resource-protocol/core";
import { createHarness, tick } from "./test-support";

const ArrayBufferSchema = z.custom<ArrayBuffer>(
  (v) => v instanceof ArrayBuffer,
);

function setup(opts: { revalidate?: () => Promise<string> } = {}) {
  const h = createHarness();
  let runs = 0;
  let payload = new Uint8Array([1, 2, 3]).buffer;
  const resource = h.runtime.defineExternalResource(
    {
      key: "b",
      schema: ArrayBufferSchema,
      validateParams: () => {},
      bytes: true,
    },
    {
      mode: "invalidate",
      loader: () => {
        runs++;
        return payload;
      },
      ...(opts.revalidate !== undefined ? { revalidate: opts.revalidate } : {}),
    },
  );
  return {
    h,
    resource,
    runs: () => runs,
    setPayload: (b: ArrayBuffer) => {
      payload = b;
    },
  };
}

const get = (
  h: ReturnType<typeof createHarness>,
  headers: Record<string, string> = {},
) =>
  h.runtime.handleResourceHttp(
    new Request("http://x/api/resources/b?p=1", { headers }),
    { key: "b" },
  );

describe("bytes resource", () => {
  test("HTTP: octet-stream body, envelope in headers, no-store", async () => {
    const { h } = setup();
    const res = await get(h);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const envelope = parseResourceBytesHeaders("b", res.headers);
    expect(envelope.version).toBe(0);
    expect(typeof envelope.epoch).toBe("string");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  test("HTTP: revalidate stamps the ETag and an unchanged one answers 304", async () => {
    let sig = "s1";
    const { h, runs, setPayload } = setup({ revalidate: async () => sig });
    const first = await get(h);
    const etag = first.headers.get("ETag");
    expect(etag).not.toBeNull();
    expect(runs()).toBe(1);
    const same = await get(h, { "If-None-Match": etag! });
    expect(same.status).toBe(304);
    expect(runs()).toBe(1);
    sig = "s2";
    setPayload(new Uint8Array([9]).buffer);
    const changed = await get(h, { "If-None-Match": etag! });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("ETag")).not.toBe(etag);
    expect(new Uint8Array(await changed.arrayBuffer())).toEqual(
      new Uint8Array([9]),
    );
  });

  test("WS: the sub-ack carries no value and runs no loader; the version and epoch still ride it", async () => {
    const { h, runs } = setup();
    await h.subscribe("b", { p: "1" });
    const ack = h.frames.at(-1) as unknown as Record<string, unknown>;
    expect(ack).toMatchObject({
      kind: "sub-ack",
      key: "b",
      params: { p: "1" },
    });
    expect(typeof ack.version).toBe("number");
    expect(typeof ack.epoch).toBe("string");
    expect("value" in ack).toBe(false);
    expect("etag" in ack).toBe(false);
    expect(runs()).toBe(0);
  });

  test("WS: a notify sends an invalidate frame, never the value", async () => {
    const { h, resource, runs } = setup();
    await h.subscribe("b", { p: "1" });
    resource.notify({ p: "1" });
    await tick();
    await tick();
    const last = h.frames.at(-1) as unknown as Record<string, unknown>;
    expect(last).toMatchObject({ kind: "invalidate", key: "b" });
    expect(runs()).toBe(0);
  });

  test("a bytes resource is mode invalidate only", () => {
    const h = createHarness();
    expect(() =>
      h.runtime.defineExternalResource(
        {
          key: "pushed",
          schema: ArrayBufferSchema,
          validateParams: () => {},
          bytes: true,
        },
        { mode: "push", loader: () => new ArrayBuffer(1) },
      ),
    ).toThrow(/a bytes resource is mode "invalidate"/);
  });
});
