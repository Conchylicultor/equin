import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { defineScopedStore } from "./scoped-store";

const Counter = defineScopedStore<{ n: number; label: string }>({
  n: 3,
  label: "three",
});

function Probe() {
  const state = Counter.useStore();
  const label = Counter.useSelector((s) => s.label.toUpperCase(), []);
  return <i>{`${String(state.n)},${label}`}</i>;
}

// A static render to HTML (react-dom/server, no DOM) reads the provider's
// store as it stands: whole state and a selected slice, without throwing.
describe("a scoped store under a server render", () => {
  it("reads the provider's state and a selected slice", () => {
    expect(
      renderToStaticMarkup(
        <Counter.Provider>
          <Probe />
        </Counter.Provider>,
      ),
    ).toBe("<i>3,THREE</i>");
  });

  it("reads a provider's own initial state", () => {
    expect(
      renderToStaticMarkup(
        <Counter.Provider initial={{ n: 7, label: "seven" }}>
          <Probe />
        </Counter.Provider>,
      ),
    ).toBe("<i>7,SEVEN</i>");
  });
});
