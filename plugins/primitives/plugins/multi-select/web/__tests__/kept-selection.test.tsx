import { act, cleanup, render } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  installStorage,
  QuotaStorage,
} from "@plugins/primitives/plugins/dom/plugins/web-storage/web/testing";
import {
  flushKept,
  KeepScope,
} from "@plugins/primitives/plugins/kept-state/web";
import { MultiSelectProvider } from "../internal/multi-select-provider";
import {
  useMultiSelect,
  type MultiSelectHandle,
} from "../internal/use-multi-select";

beforeAll(() => {
  installStorage("local", new QuotaStorage());
  installStorage("session", new QuotaStorage());
});
afterEach(cleanup);

let handle: MultiSelectHandle;
const setHandle = (h: MultiSelectHandle) => {
  handle = h;
};
function Probe({
  onHandle,
}: {
  onHandle: (h: MultiSelectHandle) => void;
}): ReactNode {
  const h = useMultiSelect();
  useEffect(() => {
    onHandle(h);
  });
  return null;
}

let pane = 0;
function mount(segment: string, keep: string, ids: readonly string[]) {
  return render(
    <KeepScope segment="t:tab">
      <KeepScope segment={segment}>
        <MultiSelectProvider keep={keep} orderedIds={ids}>
          <Probe onHandle={setHandle} />
        </MultiSelectProvider>
      </KeepScope>
    </KeepScope>,
  );
}

const selected = () => [...handle.selectedIds].sort();

describe("MultiSelectProvider keeps its selection as view state", () => {
  it("gives the selection back on a remount of the same place and list", () => {
    const place = `p:${++pane}`;
    const first = mount(place, "list", ["a", "b", "c"]);
    act(() => handle.setRange("a", "b"));
    expect(selected()).toEqual(["a", "b"]);
    first.unmount();
    flushKept();

    mount(place, "list", ["a", "b", "c"]);
    expect(selected()).toEqual(["a", "b"]);
    cleanup();

    // Another list in the same place, or the same list in another place,
    // starts empty.
    mount(place, "other-list", ["a", "b", "c"]);
    expect(selected()).toEqual([]);
    cleanup();
    mount(`p:${++pane}`, "list", ["a", "b", "c"]);
    expect(selected()).toEqual([]);
  });

  it("waits for rows that load after the mount, dropping rows that are gone", () => {
    const place = `p:${++pane}`;
    const first = mount(place, "list", ["a", "b", "c"]);
    act(() => handle.setRange("b", "c"));
    first.unmount();
    flushKept();

    const ids: readonly string[] = [];
    const loading = mount(place, "list", ids);
    expect(selected()).toEqual([]);
    const loaded = ["a", "c"];
    loading.rerender(
      <KeepScope segment="t:tab">
        <KeepScope segment={place}>
          <MultiSelectProvider keep="list" orderedIds={loaded}>
            <Probe onHandle={setHandle} />
          </MultiSelectProvider>
        </KeepScope>
      </KeepScope>,
    );
    expect(selected()).toEqual(["c"]);
  });
});
