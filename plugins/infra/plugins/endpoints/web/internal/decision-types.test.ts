import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { defineEndpoint } from "../../core/define-endpoint";
import { brandEndpointEffect } from "../../core/endpoint-effect";
import { implement } from "../../core/implement";
import type { PredictionGap } from "../../core/prediction";
import { useEndpointMutation } from "./use-endpoint-mutation";
import type { FetchEndpoint } from "./fetch-endpoint";

// Every write decides how its effect reaches the user — exactly one arm of
// `defineEndpoint`'s options: `effect`, `unpredicted`, `internal`, or none
// for `agentWrite: "telemetry"` (research/2026-10-28-global-endpoint-
// prediction-decision.md §1). The bodies are never run (no React tree): tsc
// is the assertion; the runtime backstop is tested below.

function _eachArmCompiles() {
  defineEndpoint({
    route: "POST /api/d/predicted",
    effect: (_on) => brandEndpointEffect({}),
  });
  defineEndpoint({
    route: "POST /api/d/reason",
    unpredicted: { reason: "precondition", why: "409 shown inline" },
  });
  defineEndpoint({
    route: "POST /api/d/gap",
    unpredicted: { gap: "web-context" },
  });
  defineEndpoint({
    route: "POST /api/d/internal",
    internal: { why: "server → central RPC" },
  });
  // A telemetry write needs no arm: `agentWrite` is the decision.
  defineEndpoint({ route: "POST /api/d/beacon", agentWrite: "telemetry" });
  // "agent-control" is not a decision: it rides on an arm.
  defineEndpoint({
    route: "POST /api/d/revert",
    agentWrite: "agent-control",
    unpredicted: { reason: "server-decided", why: "the ledger decides" },
  });
  // A read decides nothing.
  defineEndpoint({ route: "GET /api/d", response: z.object({}) });
}

function _undecided() {
  // @ts-expect-error — a write with no arm
  defineEndpoint({ route: "POST /api/d/none" });
  // @ts-expect-error — nor is "agent-control" one
  defineEndpoint({ route: "POST /api/d/ctl", agentWrite: "agent-control" });
}

function _twoArms() {
  // @ts-expect-error — effect and unpredicted
  defineEndpoint({
    route: "POST /api/d/two",
    effect: (_on) => brandEndpointEffect({}),
    unpredicted: { gap: "web-context" },
  });
  // @ts-expect-error — unpredicted and internal
  defineEndpoint({
    route: "POST /api/d/two",
    unpredicted: { reason: "response", why: "x" },
    internal: { why: "y" },
  });
  // @ts-expect-error — telemetry is an arm of its own
  defineEndpoint({
    route: "POST /api/d/two",
    agentWrite: "telemetry",
    internal: { why: "y" },
  });
}

function _armShapes() {
  defineEndpoint({
    route: "POST /api/d/x",
    // @ts-expect-error — a reason needs its why
    unpredicted: { reason: "response" },
  });
  // @ts-expect-error — internal needs its why
  defineEndpoint({ route: "POST /api/d/x", internal: {} });
  defineEndpoint({
    route: "POST /api/d/x",
    // @ts-expect-error — a gap names its task in PREDICTION_GAPS, not here
    unpredicted: { gap: "web-context", reason: "response", why: "x" },
  });
  defineEndpoint({
    route: "POST /api/d/x",
    // @ts-expect-error — not an UnpredictedReason
    unpredicted: { reason: "slow", why: "x" },
  });
  // @ts-expect-error — not a PredictionGap (a closed gap is deleted)
  const _gap: PredictionGap = "spinners";
  defineEndpoint({
    route: "POST /api/d/x",
    // @ts-expect-error — so no endpoint can declare it
    unpredicted: { gap: "spinners" },
  });
}

function _readsDeclareNone() {
  // @ts-expect-error — a read is not unpredicted
  defineEndpoint({
    route: "GET /api/d/r",
    unpredicted: { reason: "response", why: "x" },
  });
  // @ts-expect-error — nor internal
  defineEndpoint({ route: "GET /api/d/r", internal: { why: "x" } });
}

const secretsGet = defineEndpoint({
  route: "POST /api/d/secrets/get",
  body: z.object({ name: z.string() }),
  response: z.object({ value: z.string() }),
  internal: { why: "server → central RPC; a POST keeps the name out of URLs" },
});

const hostHook = defineEndpoint({
  route: "POST /api/d/host-hook",
  needsMachine: { feature: "A host hook" },
  internal: { why: "called by the CLI only" },
});

function useInternalOnTheBrowser() {
  // @ts-expect-error — an internal endpoint has no browser mutation
  useEndpointMutation(secretsGet);
  // @ts-expect-error — nor its desktop-only twin
  useEndpointMutation(hostHook);
}

async function _fetchInternal(fetchEndpoint: FetchEndpoint) {
  // @ts-expect-error — an internal endpoint is never fetched from a page
  await fetchEndpoint(secretsGet, {}, { body: { name: "k" } });
  // @ts-expect-error — nor its desktop-only twin
  await fetchEndpoint(hostHook, {});
}

// The server serves it (`implementMachine` and `callEndpoint` take it too —
// their own tests pin it).
function _serverTakesIt() {
  implement(secretsGet, ({ body }) => ({ value: body.name }));
  // @ts-expect-error — a desktop-only one is still never `implement`'s
  implement(hostHook, () => undefined);
}

describe("prediction decision types", () => {
  test("the type assertions above compile", () => {
    for (const fn of [
      _eachArmCompiles,
      _undecided,
      _twoArms,
      _armShapes,
      _readsDeclareNone,
      useInternalOnTheBrowser,
      _fetchInternal,
      _serverTakesIt,
    ]) {
      expect(typeof fn).toBe("function");
    }
  });
});
