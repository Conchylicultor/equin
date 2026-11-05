/**
 * `useLive(c, query, { resetKey })` — the plain window read (no viewport):
 * a query change under the same `resetKey` keeps the previous rows, `ready`,
 * until the new query's first page lands (a search typed into a picker); a
 * change of `resetKey` starts over, `loading`; and `resetKey` beside any
 * other read throws. Harness as in use-live-ancestors.test.tsx: values land
 * with `setQueryData` on the exact tuple the hook observed.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock(
  "@plugins/primitives/plugins/log-channels/web",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    clientLog: () => {},
  }),
);

import { act, renderHook, waitFor } from "@testing-library/react";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { queryKeyFor } from "@plugins/network/plugins/live/plugins/live-state/web";
import {
  createLiveStateHarness,
  NotificationsClient,
} from "@plugins/network/plugins/live/plugins/live-state/web/testing";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { useLive } from "@plugins/network/plugins/live/web";

let seq = 0;
const collection = () =>
  liveCollection(`test.use-live-reset-key.${seq++}`, {
    fields: {
      id: textField({ label: "Id" }),
      title: textField({ label: "Title" }),
      n: intField({ label: "N" }),
    },
    id: "id",
    sortable: ["n"],
    default: { orderBy: [["n", "asc"]], limit: 10 },
    maxLimit: 20,
  });

const row = (id: string, n: number) => ({
  id,
  title: id,
  n,
  $key: JSON.stringify([String(n), id]),
});

interface Props {
  q: string;
  resetKey: string;
}

function setup() {
  const c = collection();
  const live = createLiveStateHarness();
  vi.spyOn(live.notifications, "hasEverBeenReady").mockReturnValue(true);
  const observe = vi.spyOn(NotificationsClient.prototype, "observe");
  const rendered = renderHook(
    ({ q, resetKey }: Props) =>
      useLive(
        c,
        { where: q === "" ? undefined : { title: { contains: q } }, limit: 5 },
        { resetKey },
      ),
    {
      wrapper: live.Wrapper,
      initialProps: { q: "", resetKey: "picker" },
    },
  );
  /** The window tuple the hook observed last. */
  const lastTuple = (): Record<string, string> =>
    observe.mock.calls.filter(([k]) => k === c.key).at(-1)![1] as Record<
      string,
      string
    >;
  const land = (rows: unknown[]) =>
    act(() => {
      live.queryClient.setQueryData(queryKeyFor(c.key, lastTuple()), rows);
    });
  const ids = () => {
    const r = rendered.result.current;
    return r.status === "ready" ? r.data.map((x) => x.id) : r.status;
  };
  return { ...rendered, observe, land, ids, c };
}

describe("useLive(c, query, { resetKey })", () => {
  it("a query change under the same resetKey stays ready on the previous rows until the new head lands", async () => {
    const { rerender, land, ids, observe } = setup();
    expect(ids()).toBe("loading");
    land([row("a", 1), row("ab", 2), row("b", 3)]);
    await waitFor(() => expect(ids()).toEqual(["a", "ab", "b"]));

    rerender({ q: "a", resetKey: "picker" });
    // A new tuple is read, and the previous rows stay on screen meanwhile.
    expect(
      observe.mock.calls.filter(([, p]) =>
        JSON.stringify(p).includes("contains"),
      ).length,
    ).toBe(1);
    expect(ids()).toEqual(["a", "ab", "b"]);
    land([row("a", 1), row("ab", 2)]);
    await waitFor(() => expect(ids()).toEqual(["a", "ab"]));
    observe.mockRestore();
  });

  it("a different resetKey starts over: loading until the new head lands", async () => {
    const { rerender, land, ids, observe } = setup();
    land([row("a", 1), row("b", 2)]);
    await waitFor(() => expect(ids()).toEqual(["a", "b"]));
    rerender({ q: "b", resetKey: "another" });
    expect(ids()).toBe("loading");
    land([row("b", 2)]);
    await waitFor(() => expect(ids()).toEqual(["b"]));
    observe.mockRestore();
  });

  it("refuses a resetKey beside a read that is no window", () => {
    const c = collection();
    const live = createLiveStateHarness();
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      renderHook(
        () => useLive(c, { id: "a" } as never, { resetKey: "x" } as never),
        { wrapper: live.Wrapper },
      ),
    ).toThrow(/keeps a collection's window rows across a query change/);
  });
});
