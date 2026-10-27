import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import {
  PluginProvider,
  type Contribution,
} from "@plugins/framework/plugins/web-sdk/core";
import type { ConfigDescriptor } from "@plugins/config_v2/core";
import { ReorderListMiddleware } from "../internal/list-middleware";

/**
 * The list middleware renders a slot only once its layout is KNOWN. Drawing the
 * contributions in raw order while the config document loads is the first-paint
 * flash (hidden items shown, then the jump to the layout); a failed read keeps
 * its last-known layout in the same element, so a transient error remounts
 * nothing.
 */

type Doc = { items?: unknown[] };
const refetch = () => Promise.resolve();
const error = new Error("boom");
let config:
  | { status: "loading"; refetch: typeof refetch }
  | { status: "ready"; data: Doc; refetch: typeof refetch }
  | { status: "error"; error: Error; stale?: Doc; refetch: typeof refetch } = {
  status: "loading",
  refetch,
};

vi.mock("@plugins/config_v2/web", () => ({
  useConfigResult: () => config,
  useSetConfig: () => () => {},
}));

vi.mock("../internal/descriptors", () => ({
  reorderDescriptors: new Map([["test.slot", {} as ConfigDescriptor]]),
}));

const contributions = ["a", "b", "c"].map(
  (id) => ({ _pluginId: "test.plugin", id }) as unknown as Contribution,
);

let mounts = 0;
function Item({ id }: { id: string }) {
  useEffect(() => {
    mounts++;
  }, []);
  return <span data-testid="item">{id}</span>;
}

const idOf = (c: Contribution) => (c as unknown as { id: string }).id;
const renderItem = (c: Contribution): ReactNode => (
  <Item key={idOf(c)} id={idOf(c)} />
);

function Host() {
  return (
    <PluginProvider plugins={[]}>
      <ReorderListMiddleware
        slotId="test.slot"
        contributions={contributions}
        renderItem={renderItem}
      >
        {null}
      </ReorderListMiddleware>
    </PluginProvider>
  );
}

function drawn(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-testid="item"]')].map(
    (el) => el.textContent ?? "",
  );
}

const LAYOUT = [
  "test.plugin:c",
  { item: "test.plugin:b", hidden: true },
  "test.plugin:a",
];

beforeEach(() => {
  mounts = 0;
});
afterEach(cleanup);

describe("ReorderListMiddleware while the layout is not known", () => {
  it("renders nothing while loading — never the raw order", () => {
    config = { status: "loading", refetch };
    const { container } = render(<Host />);
    expect(drawn(container)).toEqual([]);
    expect(mounts).toBe(0);
  });

  it("renders the layout order, hidden items dropped, once ready", () => {
    config = { status: "loading", refetch };
    const { container, rerender } = render(<Host />);
    config = { status: "ready", data: { items: LAYOUT }, refetch };
    rerender(<Host />);
    expect(drawn(container)).toEqual(["c", "a"]);
  });

  it("keeps one mount across ready → error-with-stale", () => {
    config = { status: "ready", data: { items: LAYOUT }, refetch };
    const { container, rerender } = render(<Host />);
    expect(mounts).toBe(2);
    const before = container.querySelector('[data-testid="item"]');
    act(() => {
      config = { status: "error", error, stale: { items: LAYOUT }, refetch };
      rerender(<Host />);
    });
    expect(drawn(container)).toEqual(["c", "a"]);
    expect(container.querySelector('[data-testid="item"]')).toBe(before);
    expect(mounts).toBe(2);
  });

  it("renders nothing on an error with no last-known layout", () => {
    config = { status: "error", error, refetch };
    const { container } = render(<Host />);
    expect(drawn(container)).toEqual([]);
  });

  it("treats a known document without a tree as an empty layout", () => {
    config = { status: "ready", data: {}, refetch };
    const { container } = render(<Host />);
    expect(drawn(container)).toEqual(["a", "b", "c"]);
  });
});
