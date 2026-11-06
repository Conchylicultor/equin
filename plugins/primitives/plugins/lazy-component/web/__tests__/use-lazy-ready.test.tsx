import { describe, expect, test } from "vitest";
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
