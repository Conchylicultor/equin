import { describe, expect, test, vi } from "vitest";
import { Component, type ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { lazyComponent, useLazyReady } from "../internal/lazy-component";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function Body() {
  return <div>body</div>;
}

class Boundary extends Component<{ children: ReactNode }, { error: unknown }> {
  override state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  override render() {
    return this.state.error ? <div>failed</div> : this.props.children;
  }
}

describe("useLazyReady", () => {
  test("holds the host's loading state until the chunk lands, then renders it at once", async () => {
    const chunk = deferred<{ default: typeof Body }>();
    const Lazy = lazyComponent(() => chunk.promise, { fallback: null });
    function Host() {
      const ready = useLazyReady(Lazy);
      return ready ? <Lazy /> : <div>loading</div>;
    }
    render(<Host />);
    expect(screen.getByText("loading")).toBeTruthy();
    chunk.resolve({ default: Body });
    // The host's first ready render already holds the body: no pop-in frame.
    expect(await screen.findByText("body")).toBeTruthy();
    expect(screen.queryByText("loading")).toBeNull();
  });

  test("a load that failed after the device slept is loaded again, not thrown", async () => {
    // A laptop closed mid-load, the tab in front: no event fires, but the wall
    // clock runs on while the performance timeline pauses (web-sdk's
    // page-reach), and the import in flight rejects on wake.
    const realNow = Date.now.bind(Date);
    let slept = 0;
    const spy = vi
      .spyOn(Date, "now")
      .mockImplementation(() => realNow() + slept);
    try {
      let calls = 0;
      const Lazy = lazyComponent(
        (): Promise<{ default: typeof Body }> => {
          calls++;
          if (calls === 1) {
            slept = 39 * 60_000;
            return Promise.reject(
              new TypeError("error loading dynamically imported module"),
            );
          }
          return Promise.resolve({ default: Body });
        },
        { fallback: null },
      );
      function Host() {
        return useLazyReady(Lazy) ? <Lazy /> : <div>loading</div>;
      }
      render(
        <Boundary>
          <Host />
        </Boundary>,
      );
      expect(await screen.findByText("body")).toBeTruthy();
      expect(calls).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });

  test("a failed load throws into the host's error boundary", async () => {
    const chunk = deferred<{ default: typeof Body }>();
    const Lazy = lazyComponent(() => chunk.promise, { fallback: null });
    function Host() {
      return useLazyReady(Lazy) ? <Lazy /> : <div>loading</div>;
    }
    render(
      <Boundary>
        <Host />
      </Boundary>,
    );
    chunk.reject(new Error("chunk failed"));
    expect(await screen.findByText("failed")).toBeTruthy();
  });

  test("refuses a component lazyComponent did not return", () => {
    function Host() {
      useLazyReady(Body);
      return null;
    }
    expect(() => render(<Host />)).toThrow(/not a component lazyComponent/);
  });
});
