import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { defineEndpoint } from "../../core/define-endpoint";
import type { EndpointDef, WriteEndpoint } from "../../core";
import { useEndpointMutation } from "./use-endpoint-mutation";
import type { FetchEndpoint } from "./fetch-endpoint";

// What does not compile for the browser's write clients: a read def. The bodies
// are never run (no React tree): tsc is the assertion.

const health = defineEndpoint({
  route: "GET /api/health",
  response: z.object({ ok: z.boolean() }),
});
const ping = defineEndpoint({
  route: "POST /api/ping",
  body: z.object({ n: z.number() }),
});
const stat = defineEndpoint({
  route: "GET /api/stat",
  response: z.object({ ok: z.boolean() }),
  needsMachine: { feature: "Reading a file" },
});

async function _fetchARead(fetchEndpoint: FetchEndpoint) {
  // @ts-expect-error — GET is a read: declare it live and read it with useLive
  await fetchEndpoint(health, {});
  // @ts-expect-error — a desktop-only read is a read too
  await fetchEndpoint(stat, {});
  await fetchEndpoint(ping, {}, { body: { n: 1 } });
}

function useMutateARead() {
  // @ts-expect-error — GET is a read: useEndpointMutation sends writes only
  useEndpointMutation(health);
  useEndpointMutation(ping);
}

async function _wideDef(
  fetchEndpoint: FetchEndpoint,
  wide: EndpointDef<string, unknown, unknown, unknown, unknown>,
) {
  // @ts-expect-error — a wide route may be a GET: it fails closed
  await fetchEndpoint(wide, {});
}

// A generic wrapper constrained with `& WriteEndpoint` still compiles.
async function _wrapper<Route extends string, TParams>(
  fetchEndpoint: FetchEndpoint,
  def: EndpointDef<Route, TParams, void, void, void> & WriteEndpoint,
  params: TParams,
) {
  await fetchEndpoint(def, params);
}

// Every literal def is still an `EndpointDef<string, …>` (implement,
// callEndpoint, registries take the wide type).
const _asWide: EndpointDef<string, unknown, unknown, unknown, unknown>[] = [
  health as EndpointDef<string, unknown, unknown, unknown, unknown>,
  ping as EndpointDef<string, unknown, unknown, unknown, unknown>,
];

describe("write-only client types", () => {
  test("the type assertions above compile", () => {
    expect(typeof _fetchARead).toBe("function");
    expect(typeof useMutateARead).toBe("function");
    expect(typeof _wideDef).toBe("function");
    expect(typeof _wrapper).toBe("function");
    expect(_asWide).toHaveLength(2);
  });
});
