/**
 * The toast ledger's DOM contract: `useLiveToastCount()` equals the number of
 * `[data-sonner-toast]` elements on screen, through every path a toast takes in
 * and out of the DOM.
 *
 * Two cases are regressions and are expected to FAIL against the enqueue-time
 * ledger this replaces — "a toast no <Toaster/> ever rendered" (defect A) and
 * "a toast fired from an effect above the toaster" (defect B).
 *
 * Sonner is mounted here as a bare `<Toaster/>`, not the plugin's
 * `<ToasterHost/>`: the host exists to carry theme scope, colour mode and the
 * measured action strip, none of which the ledger has an opinion about, and all
 * of which would drag the theme engine and the ui-kit into a test about a Set.
 *
 * Pinned against sonner 2.0.7; every `dist:<n>` below is a line in that
 * version's `dist/index.mjs`.
 */

import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Toaster, toast as sonnerToast } from "sonner";

import type { ToastVariant } from "../../core";
import { useLiveToastCount } from "../internal/live-toasts";
import { showToast } from "../internal/show-toast";

/** sonner's default toast lifetime (dist:417). */
const TOAST_LIFETIME = 4000;
/** sonner's exit-animation window between removal and unmount (dist:425). */
const TIME_BEFORE_UNMOUNT = 200;

const VARIANTS: ToastVariant[] = ["default", "success", "error", "warning", "info"];

function LedgerProbe() {
  const count = useLiveToastCount();
  return <div data-testid="ledger-count">{count}</div>;
}

/** Toaster-optional tree, so a rerender can unmount the host under a live probe. */
function Harness({ toaster }: { toaster: boolean }) {
  return (
    <>
      <LedgerProbe />
      {toaster ? <Toaster /> : null}
    </>
  );
}

/** Fires one toast from a passive effect, the shape the real bell button has. */
function ToastOnMount({ description }: { description: string }) {
  useEffect(() => {
    showToast({ description });
  }, [description]);
  return null;
}

function ledgerCount(): number {
  return Number(screen.getByTestId("ledger-count").textContent);
}

function mountedToasts(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-sonner-toast]"));
}

/**
 * Drive every asynchronous hop between `showToast()` and the DOM settling:
 *
 *  1. our own `queueMicrotask` deferral — drained by the `await` below;
 *  2. sonner's addition path, a `setTimeout(0)` wrapping a `ReactDOM.flushSync`
 *     (dist:969) — a zero-length tick still fires zero-delay timers;
 *  3. its dismissal hops: a `requestAnimationFrame` in the observer (dist:185)
 *     and another in the Toaster's subscriber (dist:960), then the
 *     `TIME_BEFORE_UNMOUNT` exit timer (dist:572).
 *
 * Pass `ms` to also advance real toast time (a lifetime, an exit window).
 */
async function flushToasts(ms = 0): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers({
    // `requestAnimationFrame` is load-bearing here, not incidental: every
    // dismissal hops through one, so under a frozen clock with a real rAF the
    // toast never leaves and the dismiss cases hang on an <li> that will not go
    // away. `queueMicrotask` is deliberately NOT faked — `showToast`'s
    // one-microtask deferral is the thing under test, and faking it would let
    // the test skip the very hop the fix relies on.
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "Date",
    ],
  });
});

afterEach(() => {
  // Unmounting drains the ledger through the same path production uses (the
  // toast body's effect cleanup), so the next test starts from an empty count
  // without the module needing a `clear` — which is precisely what this design
  // deleted. Sonner's own `ToastState.toasts` history does persist across tests,
  // so anything asserting on it takes a baseline rather than an absolute — and
  // since sonner 2.0.8 a `<Toaster/>` replays every still-ACTIVE toast when it
  // subscribes, so each test dismisses what it fired or the next test's toaster
  // mounts them. After `cleanup`: with no toaster subscribed, a dismiss-all
  // only marks them dismissed, and renders nothing outside `act`.
  cleanup();
  sonnerToast.dismiss();
  vi.useRealTimers();
});

describe("the toast ledger is the set of mounted toasts", () => {
  it("counts exactly the toasts that are mounted", async () => {
    render(
      <>
        <LedgerProbe />
        <Toaster />
      </>,
    );

    // Five, deliberately past sonner's `visibleToasts` default of 3: it mounts
    // all of them and only drives opacity, and sweeping the ones you cannot see
    // is the whole justification for the affordance this count feeds.
    for (const n of [1, 2, 3, 4, 5]) showToast({ description: `toast ${n}` });
    await flushToasts();

    const mounted = mountedToasts().length;
    expect(mounted).toBe(5);
    expect(ledgerCount()).toBe(mounted);
  });

  it("does not count a toast no <Toaster/> ever rendered (defect A)", async () => {
    // REGRESSION. The old ledger recorded at enqueue time and retired only from
    // sonner's exit callbacks, so an enqueue with no renderer was counted
    // forever with no repair path: the empty corner under a "Dismiss all (3)".
    render(<LedgerProbe />);

    for (const n of [1, 2, 3, 4, 5]) showToast({ description: `orphan ${n}` });
    await flushToasts();

    expect(mountedToasts()).toHaveLength(0);
    expect(ledgerCount()).toBe(0);
  });

  it("renders a toast fired from an effect above the toaster (defect B)", async () => {
    // REGRESSION, and tree order is the whole point: React runs passive creates
    // parent-first, left to right, so `ToastOnMount`'s effect fires while
    // `<Toaster/>`'s subscribe effect is still pending and `ToastState.subscribers`
    // is empty. `Observer.publish` (dist:132) is a bare forEach over that array —
    // no buffer, no replay — so an inline publish is simply dropped. Deferring
    // the enqueue one microtask lands it after the whole passive flush. This
    // mirrors the real app, where the dominant toast producer (the notifications
    // bell) sits above the toaster host.
    render(
      <>
        <LedgerProbe />
        <ToastOnMount description="from an effect" />
        <Toaster />
      </>,
    );
    await flushToasts();

    expect(mountedToasts()).toHaveLength(1);
    expect(ledgerCount()).toBe(1);
    expect(screen.getByText("from an effect")).toBeTruthy();
  });

  it("shows a toast fired before the toaster mounted, once it mounts", async () => {
    // The host mounts sonner only once its z-layer's place in the stack is
    // known (toaster-host.tsx), so a toast can be fired while no `<Toaster/>`
    // exists yet. It must not be lost: sonner 2.0.8's `Observer.subscribe`
    // replays every still-active toast to a new subscriber. If an upgrade drops
    // that replay, this fails and the host must hold a queue instead.
    const { rerender } = render(<Harness toaster={false} />);
    showToast({ description: "before the host" });
    await flushToasts();
    expect(mountedToasts()).toHaveLength(0);

    rerender(<Harness toaster />);
    await flushToasts();

    expect(mountedToasts()).toHaveLength(1);
    expect(ledgerCount()).toBe(1);
    expect(screen.getByText("before the host")).toBeTruthy();
  });

  it("defers the enqueue by exactly one microtask", async () => {
    // The deferral, observed directly at sonner's own boundary rather than
    // through the DOM: nothing reaches `ToastState` inside the caller's stack.
    render(<Toaster />);
    const before = sonnerToast.getHistory().length;

    showToast({ description: "deferred" });
    expect(sonnerToast.getHistory()).toHaveLength(before);

    await act(async () => {
      await Promise.resolve();
    });
    expect(sonnerToast.getHistory()).toHaveLength(before + 1);
  });

  it("drains the count when the action button dismisses the toast", async () => {
    const onClick = vi.fn();
    render(
      <>
        <LedgerProbe />
        <Toaster />
      </>,
    );

    showToast({ description: "undoable", action: { label: "Undo", onClick } });
    await flushToasts();
    expect(ledgerCount()).toBe(1);

    const actionButton = document.querySelector<HTMLButtonElement>("[data-action]");
    expect(actionButton).not.toBeNull();
    await act(async () => {
      fireEvent.click(actionButton!);
    });

    expect(onClick).toHaveBeenCalledTimes(1);

    // The action button is the one exit sonner reports through neither
    // `onAutoClose` nor `onDismiss` — the old ledger needed a bespoke untrack
    // inside this very handler. Now it is just another unmount, so nothing in
    // `showToast` has to know the button exists.
    await flushToasts(TIME_BEFORE_UNMOUNT + 50);
    expect(mountedToasts()).toHaveLength(0);
    expect(ledgerCount()).toBe(0);
  });

  it("keeps an exiting toast counted for its exit animation, then drops it", async () => {
    render(
      <>
        <LedgerProbe />
        <Toaster />
      </>,
    );

    showToast({ description: "expires a" });
    showToast({ description: "expires b" });
    await flushToasts();
    expect(ledgerCount()).toBe(2);

    await flushToasts(TOAST_LIFETIME);

    // AN INTENTIONAL CONTRACT, not an accident of the implementation. The ledger
    // is the mount set, and sonner keeps an exiting toast mounted for
    // TIME_BEFORE_UNMOUNT while it fades out. So the count is exactly "toasts
    // currently painted": the affordance fades with the stack instead of zeroing
    // 200ms early, and a throttled tab (where the dismissal rAF is delayed) can
    // no longer show 0 under a corner that still has toasts in it. If you are
    // here because this failed, the question to answer is whether the ledger
    // stopped being the mount set — not whether to relax the assertion.
    const exiting = mountedToasts();
    expect(exiting).toHaveLength(2);
    expect(exiting.map((li) => li.getAttribute("data-removed"))).toEqual(["true", "true"]);
    expect(ledgerCount()).toBe(2);

    await flushToasts(TIME_BEFORE_UNMOUNT);
    expect(mountedToasts()).toHaveLength(0);
    expect(ledgerCount()).toBe(0);
  });

  it("drains the count when the host unmounts", async () => {
    const { rerender } = render(<Harness toaster />);

    showToast({ description: "host goes away a" });
    showToast({ description: "host goes away b" });
    await flushToasts();
    expect(ledgerCount()).toBe(2);

    // No lifecycle hook clears the ledger any more. React unmounting the toast
    // subtrees is the only thing that has to happen, and it happens whether the
    // toaster goes away with its host or on its own.
    await act(async () => {
      rerender(<Harness toaster={false} />);
    });

    expect(mountedToasts()).toHaveLength(0);
    expect(ledgerCount()).toBe(0);
  });

  it.each(VARIANTS)("mounts the toast body for the %s variant", async (variant) => {
    // `default` goes through sonner's `toastFunction` (dist:373) and every other
    // variant through `Observer.create` (dist:142) — two different id-assignment
    // and publish paths, both of which have to honour the explicit non-empty
    // string id the body is keyed by. Cheap insurance against a sonner bump.
    render(
      <>
        <LedgerProbe />
        <Toaster />
      </>,
    );

    showToast({ description: `a ${variant} toast`, variant });
    await flushToasts();

    expect(mountedToasts()).toHaveLength(1);
    expect(ledgerCount()).toBe(1);
    expect(screen.getByText(`a ${variant} toast`)).toBeTruthy();
  });

  it("counts a description-only toast exactly once", async () => {
    render(
      <>
        <LedgerProbe />
        <Toaster />
      </>,
    );

    showToast({ description: "just a description" });
    await flushToasts();

    // With no title the description IS the message, so sonner renders no
    // `[data-description]` div at all (dist:797) — there is only one slot the
    // body could be in.
    expect(mountedToasts()).toHaveLength(1);
    expect(document.querySelectorAll("[data-description]")).toHaveLength(0);
    expect(ledgerCount()).toBe(1);
  });

  it("counts a title + description toast exactly once, registering in the title only", async () => {
    render(
      <>
        <LedgerProbe />
        <Toaster />
      </>,
    );

    showToast({ title: "The title", description: "The description" });
    await flushToasts();

    expect(mountedToasts()).toHaveLength(1);
    expect(ledgerCount()).toBe(1);

    // The body must register in the TITLE slot only. Sonner renders
    // `[data-title]` unconditionally (dist:794) but `[data-description]` only
    // when a description is present, so two registrations behind one Set entry
    // would let the first unmount untrack a toast the other half is still
    // showing — an undercount, the worse direction. The body's anchor is the
    // only <span> either slot would contain, which is what makes the absence
    // below assertable.
    const title = document.querySelector("[data-title]");
    const description = document.querySelector("[data-description]");
    expect(title).not.toBeNull();
    expect(description).not.toBeNull();
    expect(title!.querySelector("span")).not.toBeNull();
    expect(description!.querySelector("span")).toBeNull();
  });

  it("falls back to the description when the title is an empty string", async () => {
    // Drive-by from the same change: `title ?? description` let `title: ""`
    // through, rendering an empty toast and silently dropping the description.
    render(
      <>
        <LedgerProbe />
        <Toaster />
      </>,
    );

    showToast({ title: "", description: "the only text there is" });
    await flushToasts();

    expect(screen.getByText("the only text there is")).toBeTruthy();
    expect(ledgerCount()).toBe(1);
  });
});

describe("click-to-dismiss", () => {
  /** A custom toast with words and one control of its own. */
  async function showCustom(onControl: () => void): Promise<void> {
    render(
      <>
        <LedgerProbe />
        <Toaster />
      </>,
    );
    showToast({
      duration: Infinity,
      render: () => (
        <div>
          <p>the body</p>
          <button type="button" onClick={onControl}>
            Act
          </button>
        </div>
      ),
    });
    await flushToasts();
    expect(ledgerCount()).toBe(1);
  }

  it("a click on the toast's body dismisses it", async () => {
    await showCustom(() => {});
    expect(mountedToasts()[0]!.style.cursor).toBe("pointer");
    await act(async () => {
      fireEvent.click(screen.getByText("the body"));
    });
    // The dismissal hops through a (faked) animation frame before the exit.
    await flushToasts(50);
    expect(
      mountedToasts().map((li) => li.getAttribute("data-removed")),
    ).toEqual(["true"]);
    await flushToasts(TIME_BEFORE_UNMOUNT + 50);
    expect(mountedToasts()).toHaveLength(0);
    expect(ledgerCount()).toBe(0);
  });

  it("a click on a control inside the toast is the control's, not a dismiss", async () => {
    const onControl = vi.fn();
    await showCustom(onControl);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Act" }));
    });
    await flushToasts(50);
    await flushToasts(TIME_BEFORE_UNMOUNT + 50);
    expect(onControl).toHaveBeenCalledTimes(1);
    expect(mountedToasts()).toHaveLength(1);
  });
});
