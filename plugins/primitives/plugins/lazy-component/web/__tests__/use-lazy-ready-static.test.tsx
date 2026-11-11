import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { lazyComponent, useLazyReady } from "../internal/lazy-component";
import { loadLazyComponents } from "../testing";

function Body() {
  return <b>body</b>;
}

// A server render (react-dom/server) of a live page — no static render
// declared — reads where the chunk stands as it renders: it must not throw, and
// it starts no load. A static render waits for the chunk instead
// (use-lazy-ready-prerender.test.tsx).
describe("useLazyReady under a server render of a live page", () => {
  test("answers ready for a chunk loaded before the render", async () => {
    const Lazy = lazyComponent(() => Promise.resolve({ default: Body }));
    function Host() {
      return useLazyReady(Lazy) ? <Lazy /> : <i>not ready</i>;
    }
    await loadLazyComponents();
    expect(renderToStaticMarkup(<Host />)).toBe("<b>body</b>");
  });

  test("answers not ready, and loads nothing, for a chunk never loaded", () => {
    let calls = 0;
    const Lazy = lazyComponent(() => {
      calls += 1;
      return Promise.resolve({ default: Body });
    });
    function Host() {
      return useLazyReady(Lazy) ? <Lazy /> : <i>not ready</i>;
    }
    expect(renderToStaticMarkup(<Host />)).toBe("<i>not ready</i>");
    expect(calls).toBe(0);
  });
});
