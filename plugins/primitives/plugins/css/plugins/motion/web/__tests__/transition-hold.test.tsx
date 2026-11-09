/**
 * A view transition's new picture waits for the surfaces mounted inside its
 * update that are not presentable yet (a map before its tiles), bounded —
 * and a surface mounting outside any transition holds nothing.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { flushSync } from "react-dom";
import type { ReactElement } from "react";
import {
  openTransitionHolds,
  useTransitionHold,
} from "../internal/transition-hold";

function Surface({ pending }: { pending: boolean }): ReactElement {
  useTransitionHold(pending);
  return <div />;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("transition holds", () => {
  it("resolves at once when nothing holds", async () => {
    const holds = openTransitionHolds();
    await holds.settled(10_000);
  });

  it("waits for a surface mounted in the update until it lets go", async () => {
    const holds = openTransitionHolds();
    let view!: ReturnType<typeof render>;
    flushSync(() => {
      view = render(<Surface pending />);
    });
    let done = false;
    const settled = holds.settled(10_000).then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    act(() => view.rerender(<Surface pending={false} />));
    await settled;
    expect(done).toBe(true);
  });

  it("keeps waiting when one commit swaps a hold for another", async () => {
    const holds = openTransitionHolds();
    function Swap({ data }: { data: boolean }): ReactElement {
      // A loading state, replaced in one commit by the surface its data reveals.
      return data ? (
        <Surface key="map" pending />
      ) : (
        <Surface key="loading" pending />
      );
    }
    let view!: ReturnType<typeof render>;
    flushSync(() => {
      view = render(<Swap data={false} />);
    });
    let done = false;
    const settled = holds.settled(10_000).then(() => (done = true));
    act(() => view.rerender(<Swap data />));
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(done).toBe(false);
    act(() => view.unmount());
    await settled;
    expect(done).toBe(true);
  });

  it("gives up after the budget", async () => {
    vi.useFakeTimers();
    const holds = openTransitionHolds();
    render(<Surface pending />);
    let done = false;
    const settled = holds.settled(500).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(499);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await settled;
    expect(done).toBe(true);
  });

  it("a surface mounted outside a transition holds nothing", async () => {
    render(<Surface pending />);
    const holds = openTransitionHolds();
    await holds.settled(10_000);
  });
});
