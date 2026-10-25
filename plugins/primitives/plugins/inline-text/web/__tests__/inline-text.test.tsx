import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { useMemo, type ReactNode } from "react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import {
  InlineText,
  InlineTextWalkerSlot,
  InlineTextWalkerContext,
  useInlineTextWalker,
} from "../index";

// A fixture walker that wraps the running content in a marked <span>. Because
// transforms compose via reduce([…], seed), a lower-stage walker's transform
// runs *first* (innermost) and higher-stage walkers wrap its output — so the
// DOM nests highest-stage outermost. This pins ordering + that the seed is the
// raw string (the only thing `text` accepts — a component root is impossible).
function makeWalker(testid: string) {
  return function Walker({ children }: { children: ReactNode }) {
    const value = useInlineTextWalker(
      useMemo(
        () => ({
          transform: (c: ReactNode) => <span data-testid={testid}>{c}</span>,
        }),
        [],
      ),
    );
    return (
      <InlineTextWalkerContext.Provider value={value}>
        {children}
      </InlineTextWalkerContext.Provider>
    );
  };
}

const plugin = {
  id: "inline-text-ordering-test",
  description: "inline-text ordering fixture",
  contributions: [
    InlineTextWalkerSlot({
      id: "first",
      stage: 0,
      Component: makeWalker("first"),
    }),
    InlineTextWalkerSlot({
      id: "second",
      stage: 10,
      Component: makeWalker("second"),
    }),
  ],
} as unknown as LoadedPlugin;

afterEach(cleanup);

describe("InlineText composes registered walkers in order", () => {
  it("seeds with the raw string and applies walkers by ascending stage", () => {
    const { getByTestId } = render(
      <PluginProvider plugins={[plugin]}>
        <InlineText text="hello" />
      </PluginProvider>,
    );
    const first = getByTestId("first");
    const second = getByTestId("second");
    // stage 0 runs first → innermost; stage 10 wraps its output → outermost.
    expect(second.contains(first)).toBe(true);
    expect(first.contains(second)).toBe(false);
    // The raw string seed reaches the innermost walker untouched.
    expect(first.textContent).toBe("hello");
  });

  it("renders the bare string when no walkers are registered", () => {
    const empty = {
      id: "inline-text-empty",
      description: "no walkers",
      contributions: [],
    } as unknown as LoadedPlugin;
    const { container } = render(
      <PluginProvider plugins={[empty]}>
        <InlineText text="just text" />
      </PluginProvider>,
    );
    expect(container.textContent).toBe("just text");
  });
});
