import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createProbeStore, useProbes, type ProbeStore } from "./probe-store";

function Probe({ store }: { store: ProbeStore<string> }) {
  const probes = useProbes(store);
  return (
    <i>
      {[...probes.available].map(([id, on]) => `${id}=${String(on)}`).join(",")}
      |{[...probes.badge].map(([id, b]) => `${id}=${String(b)}`).join(",")}
    </i>
  );
}

// A static render to HTML (react-dom/server, no DOM) reads the probes'
// answers as the store holds them: it must not throw.
describe("useProbes under a server render", () => {
  it("reads no answers before any probe reported", () => {
    expect(
      renderToStaticMarkup(<Probe store={createProbeStore<string>()} />),
    ).toBe("<i>|</i>");
  });

  it("reads the answers reported before the render", () => {
    const store = createProbeStore<string>();
    store.set("available", "a", true);
    store.set("badge", "a", "3");
    expect(renderToStaticMarkup(<Probe store={store} />)).toBe(
      "<i>a=true|a=3</i>",
    );
  });
});
