import { afterEach, describe, expect, test } from "bun:test";
import { agentOriginHeaders, markAgentContext, pageOrigin } from "./origin";

const GLOBAL = "__equinAgentOrigin";

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[GLOBAL];
});

describe("page origin", () => {
  test("an unmarked page is a person's", () => {
    expect(pageOrigin()).toEqual({ kind: "user" });
  });

  test("markAgentContext stamps the headers and a page mark pageOrigin reads", async () => {
    let headers: Record<string, string> | undefined;
    const scripts: string[] = [];
    await markAgentContext(
      {
        setExtraHTTPHeaders: async (h) => {
          headers = h;
        },
        addInitScript: async (s) => {
          scripts.push(s);
        },
      },
      "e2e:some-flow",
    );
    expect(headers).toEqual(agentOriginHeaders("e2e:some-flow"));
    expect(scripts).toHaveLength(1);
    // Run the init script as the page would, before its own scripts.
    new Function(scripts[0]!)();
    expect(pageOrigin()).toEqual({ kind: "agent", source: "e2e:some-flow" });
  });
});
