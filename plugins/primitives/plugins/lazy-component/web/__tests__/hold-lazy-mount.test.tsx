import { afterEach, describe, expect, test } from "vitest";
import { useDeferredValue, useState, type ComponentType } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { HoldLazyMount, lazyComponent } from "../internal/lazy-component";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function Body() {
  return <div>body</div>;
}

/**
 * A surface drawing its screen deferred, like the pane surface; the returned
 * call moves it from the old screen to the lazy one.
 */
function mountSurface(hold: boolean, Lazy: ComponentType<object>) {
  function Surface() {
    const [screenName, setScreen] = useState<"old" | "new">("old");
    const shown = useDeferredValue(screenName);
    return (
      <>
        <button type="button" onClick={() => setScreen("new")}>
          navigate
        </button>
        {shown === "old" ? (
          <div>old screen</div>
        ) : (
          <HoldLazyMount active={hold}>
            <div>new chrome</div>
            <Lazy />
          </HoldLazyMount>
        )}
      </>
    );
  }
  render(<Surface />);
  return async () => {
    await act(async () => {
      fireEvent.click(screen.getByText("navigate"));
      await Promise.resolve();
    });
  };
}

afterEach(cleanup);

describe("HoldLazyMount", () => {
  test("a deferred render mounting a lazy component keeps the previous screen until the chunk lands", async () => {
    const chunk = deferred<{ default: typeof Body }>();
    const Lazy = lazyComponent(() => chunk.promise, {
      fallback: <div>spinner</div>,
    });
    const navigate = mountSurface(true, Lazy);
    await navigate();
    expect(screen.getByText("old screen")).toBeTruthy();
    expect(screen.queryByText("new chrome")).toBeNull();
    expect(screen.queryByText("spinner")).toBeNull();
    await act(async () => {
      chunk.resolve({ default: Body });
      await chunk.promise;
    });
    expect(await screen.findByText("body")).toBeTruthy();
    expect(screen.getByText("new chrome")).toBeTruthy();
    expect(screen.queryByText("old screen")).toBeNull();
  });

  test("not held, the new screen commits with the lazy fallback", async () => {
    const chunk = deferred<{ default: typeof Body }>();
    const Lazy = lazyComponent(() => chunk.promise, {
      fallback: <div>spinner</div>,
    });
    const navigate = mountSurface(false, Lazy);
    await navigate();
    expect(screen.getByText("new chrome")).toBeTruthy();
    expect(screen.getByText("spinner")).toBeTruthy();
    chunk.resolve({ default: Body });
    expect(await screen.findByText("body")).toBeTruthy();
  });
});
