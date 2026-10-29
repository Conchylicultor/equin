import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { useLiveMutation } from "./use-live-mutation";

// What `useLiveMutation` refuses besides an unpredicted def: an `internal`
// one has no browser client at all (research/2026-10-28-global-endpoint-
// prediction-decision.md §1). The body is never run: tsc is the assertion.

const secretsGet = defineEndpoint({
  route: "POST /api/lmt/secrets/get",
  body: z.object({ name: z.string() }),
  internal: { why: "server → central RPC" },
});

const hostHook = defineEndpoint({
  route: "POST /api/lmt/host-hook",
  needsMachine: { feature: "A host hook" },
  internal: { why: "called by the CLI only" },
});

const rename = defineEndpoint({
  route: "POST /api/lmt/rename",
  unpredicted: { gap: "web-context" },
});

function useInternal() {
  // @ts-expect-error — an internal endpoint has no browser client
  useLiveMutation(secretsGet);
  // @ts-expect-error — nor its desktop-only twin
  useLiveMutation(hostHook);
  // @ts-expect-error — an unpredicted one is useEndpointMutation's
  useLiveMutation(rename);
}

describe("useLiveMutation types", () => {
  test("the type assertions above compile", () => {
    expect(typeof useInternal).toBe("function");
  });
});
