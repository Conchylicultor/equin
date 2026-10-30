import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { defineEndpoint } from "../../core/define-endpoint";
import { useEndpointMutation } from "./use-endpoint-mutation";
import type { FetchEndpoint } from "./fetch-endpoint";

// What does not compile for a desktop-only endpoint's client: its answer and
// its mutation are reached only through the unavailable arm. The bodies are
// never run (no React tree): tsc is the assertion.

const launch = defineEndpoint({
  route: "POST /api/launch",
  body: z.object({ n: z.number() }),
  response: z.object({ ok: z.boolean() }),
  needsMachine: { feature: "Launching an agent" },
});

function useMutateWithoutNarrowing() {
  const mutation = useEndpointMutation(launch);
  // @ts-expect-error — `mutate` is only on the `available` arm
  mutation.mutate({ body: { n: 1 } });
  if (mutation.kind === "available") mutation.mutate({ body: { n: 1 } });
}

async function _valueWithoutNarrowing(fetchEndpoint: FetchEndpoint) {
  const res = await fetchEndpoint(launch, {}, { body: { n: 1 } });
  // @ts-expect-error — the value is only on the `ok` arm
  void res.ok;
  if (res.kind === "ok") void res.value.ok;
}

describe("needsMachine client types", () => {
  test("the type assertions above compile", () => {
    expect(typeof useMutateWithoutNarrowing).toBe("function");
    expect(typeof _valueWithoutNarrowing).toBe("function");
  });
});
