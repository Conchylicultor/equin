import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

import {
  PluginProvider,
  PluginScope,
} from "@plugins/framework/plugins/web-sdk/core";
import { SurfaceIdContext } from "@plugins/primitives/plugins/scope/plugins/surface-id/web";
import { setFocusedSurfaceId } from "../internal/focused-surface";
import {
  defineSurfaceSignal,
  useFocusedSurfaceSignal,
  useSurfaceSignal,
} from "../internal/surface-signal";

// A surface signal is read through the FOCUSED surface, which is page-global:
// a surface inside a `<PluginScope>` (the demo's embed) can be focused while
// page chrome reads. The reader sees an entry only from its own scope.

const signal = defineSurfaceSignal<string>("test.signal");
const DEMO = { id: "demo-scope", home: null, plugins: [] };

function Publish({
  surface,
  value,
}: {
  surface: string;
  value: string | null;
}) {
  return (
    <SurfaceIdContext.Provider value={surface}>
      <Publisher value={value} />
    </SurfaceIdContext.Provider>
  );
}

function Publisher({ value }: { value: string | null }) {
  useSurfaceSignal(signal, value);
  return null;
}

function Read({ testId }: { testId: string }) {
  const value = useFocusedSurfaceSignal(signal);
  return <span data-testid={testId}>{value ?? "none"}</span>;
}

function Page({ children }: { children: ReactNode }) {
  return <PluginProvider plugins={[]}>{children}</PluginProvider>;
}

afterEach(() => {
  cleanup();
  act(() => setFocusedSurfaceId(undefined));
});

describe("surface signals", () => {
  it("page chrome reads the focused page surface's value", () => {
    render(
      <Page>
        <Publish surface="page-tab" value="task-1" />
        <Read testId="chrome" />
      </Page>,
    );
    expect(screen.getByTestId("chrome").textContent).toBe("none");
    act(() => setFocusedSurfaceId("page-tab"));
    expect(screen.getByTestId("chrome").textContent).toBe("task-1");
  });

  it("a value published inside a PluginScope never reaches page chrome", () => {
    render(
      <Page>
        <PluginScope composition={DEMO}>
          <Publish surface="embed-tab" value="task-demo" />
          <Read testId="inside" />
        </PluginScope>
        <Read testId="chrome" />
      </Page>,
    );
    act(() => setFocusedSurfaceId("embed-tab"));
    expect(screen.getByTestId("chrome").textContent).toBe("none");
    expect(screen.getByTestId("inside").textContent).toBe("task-demo");
  });

  it("a background publisher leaving keeps the foreground one's value", () => {
    const { rerender } = render(
      <Page>
        <Publish key="a" surface="tab" value="task-a" />
        <Publish key="b" surface="tab" value="task-b" />
        <Read testId="chrome" />
      </Page>,
    );
    act(() => setFocusedSurfaceId("tab"));
    expect(screen.getByTestId("chrome").textContent).toBe("task-b");
    rerender(
      <Page>
        <Publish key="b" surface="tab" value="task-b" />
        <Read testId="chrome" />
      </Page>,
    );
    expect(screen.getByTestId("chrome").textContent).toBe("task-b");
  });
});
