import { describe, expect, test } from "vitest";
import { prerender } from "react-dom/static";
import type { ReactNode } from "react";
import { declareRenderMode } from "@plugins/primitives/plugins/dom/plugins/render-mode/core/testing";
import { lazyComponent, useLazyReady } from "../internal/lazy-component";

// vitest runs each file in its own module registry, so this declaration — once
// per process, by design — reaches no other suite.
declareRenderMode("static");

function Body() {
  return <b>body</b>;
}

async function prerenderToHtml(node: ReactNode): Promise<string> {
  const errors: unknown[] = [];
  const { prelude } = await prerender(node, {
    onError: (error) => void errors.push(error),
  });
  if (errors.length > 0) throw errors[0];
  return new Response(prelude).text();
}

// A static render (one render to HTML, never hydrated) has no later paint for
// the chunk to pop into: the host waits for it and renders ready.
describe("useLazyReady in a static render", () => {
  test("waits for a chunk not loaded before the render, and renders it", async () => {
    let calls = 0;
    const Lazy = lazyComponent(() => {
      calls += 1;
      return new Promise<{ default: typeof Body }>((resolve) =>
        setTimeout(() => resolve({ default: Body }), 10),
      );
    });
    function Host() {
      return useLazyReady(Lazy) ? <Lazy /> : <i>not ready</i>;
    }
    expect(await prerenderToHtml(<Host />)).toBe("<b>body</b>");
    expect(calls).toBe(1);
  });

  test("a failed load fails the render", async () => {
    const Lazy = lazyComponent<object>(() =>
      Promise.reject(new Error("chunk failed")),
    );
    function Host() {
      return useLazyReady(Lazy) ? <Lazy /> : <i>not ready</i>;
    }
    await expect(prerenderToHtml(<Host />)).rejects.toThrow("chunk failed");
  });
});

// Mounted on its own, a lazy component in a static render must not ship its
// loading state (the prerender renders a Suspense fallback eagerly, and
// `<Loading>` refuses a static render): it waits for its chunk instead.
describe("a lazy component mounted on its own in a static render", () => {
  test("waits for its chunk and renders it, never its fallback", async () => {
    const Lazy = lazyComponent(
      () =>
        new Promise<{ default: typeof Body }>((resolve) =>
          setTimeout(() => resolve({ default: Body }), 10),
        ),
    );
    expect(await prerenderToHtml(<Lazy />)).toBe("<b>body</b>");
  });

  test("a failed load fails the render", async () => {
    const Lazy = lazyComponent<object>(() =>
      Promise.reject(new Error("chunk failed")),
    );
    await expect(prerenderToHtml(<Lazy />)).rejects.toThrow("chunk failed");
  });
});
