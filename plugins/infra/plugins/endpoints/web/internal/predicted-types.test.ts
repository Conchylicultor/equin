import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { defineEndpoint, endpointContractOf } from "../../core/define-endpoint";
import { brandEndpointEffect } from "../../core/endpoint-effect";
import { implement } from "../../core/implement";
import { useEndpointMutation } from "./use-endpoint-mutation";
import type { FetchEndpoint } from "./fetch-endpoint";

// What does not compile for a predicted endpoint (`effect`): its one browser
// client is network/live's `useLiveMutation`, so the awaitable clients refuse
// it. The server and off-page clients take it. The bodies are never run (no
// React tree): tsc is the assertion. (A real effect is built by network/live's
// builders; endpoints cannot import them, so a bare payload stands in.)

const exit = defineEndpoint({
  route: "POST /api/x/:id/exit",
  effect: (_on) => brandEndpointEffect({}),
});

const launch = defineEndpoint({
  route: "POST /api/x/launch",
  body: z.object({ n: z.number() }),
  needsMachine: { feature: "Launching" },
  effect: (_on) => brandEndpointEffect({}),
});

function useAwaitPredicted() {
  // @ts-expect-error — a predicted endpoint has no awaitable mutation
  useEndpointMutation(exit);
  // @ts-expect-error — nor its desktop-only twin
  useEndpointMutation(launch);
}

async function _fetchPredicted(fetchEndpoint: FetchEndpoint) {
  // @ts-expect-error — a predicted endpoint is never raw-fetched
  await fetchEndpoint(exit, { id: "c1" });
  // @ts-expect-error — nor its desktop-only twin
  await fetchEndpoint(launch, {}, { body: { n: 1 } });
  // Its plain contract (network/live's client only, by lint) is sendable.
  await fetchEndpoint(endpointContractOf(exit), { id: "c1" });
  const res = await fetchEndpoint(
    endpointContractOf(launch),
    {},
    {
      body: { n: 1 },
    },
  );
  void res.kind;
}

function _serverTakesIt() {
  // The server ignores the effect (`implementMachine` / `callEndpoint` take
  // either kind too).
  implement(exit, ({ params }) => void params.id);
  // @ts-expect-error — a desktop-only one is still never `implement`'s
  implement(launch, () => undefined);
}

function _readsDeclareNone() {
  defineEndpoint({
    route: "GET /api/x/:id",
    // @ts-expect-error — a read declares no effect
    effect: (_on) => brandEndpointEffect({}),
  });
}

describe("predicted endpoint client types", () => {
  test("the type assertions above compile", () => {
    expect(typeof useAwaitPredicted).toBe("function");
    expect(typeof _fetchPredicted).toBe("function");
    expect(typeof _serverTakesIt).toBe("function");
    expect(typeof _readsDeclareNone).toBe("function");
  });

  test("the contract is the definition without its effect, one per definition", () => {
    expect(exit.effect).toBeDefined();
    const contract = endpointContractOf(exit);
    expect("effect" in contract).toBe(false);
    expect(contract.route).toBe("POST /api/x/:id/exit");
    expect(endpointContractOf(exit)).toBe(contract);
    expect(endpointContractOf(launch).needsMachine).toEqual({
      feature: "Launching",
    });
  });

  test("a read declaring an effect throws past a cast", () => {
    expect(() =>
      defineEndpoint({
        route: "GET /api/x",
        effect: (() => brandEndpointEffect({})) as never,
      }),
    ).toThrow(/effect.*on a read/);
  });
});
