/**
 * The toast ledger's DOM contract: `useLiveToastCount()` equals the number of
 * `[data-sonner-toast]` elements on screen, through every path a toast takes in
 * and out of the DOM — plus the stack's lifecycle around it: a toast raised
 * before the host mounts, from an effect above the toaster, its expiry,
 * click-to-dismiss, its render origin, and announcements vs replies.
 *
 * Every toast is raised the one way there is, `useShowCustomToast` (its
 * content rendered in the caller's render origin, then `sonnerToast.custom`);
 * text content is enough for a test about the ledger.
 *
 * Two cases are regressions and are expected to FAIL against the enqueue-time
 * ledger this replaces — "a toast no <Toaster/> ever rendered" (defect A) and
 * "a toast fired from an effect above the toaster" (defect B; the deferral
 * that fixes it now lives in `showCustomToast`).
 *
 * Sonner is mounted here as a bare `<Toaster/>`, not the plugin's
 * `<ToasterHost/>`: the host exists to carry theme scope, colour mode and the
 * measured action strip, none of which the ledger has an opinion about, and all
 * of which would drag the theme engine and the ui-kit into a test about a Set.
 *
 * Pinned against sonner 2.0.7; every `dist:<n>` below is a line in that
 * version's `dist/index.mjs`.
 */

import { createContext, useContext, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Toaster, toast as sonnerToast } from "sonner";

import { useLiveToastCount } from "../internal/live-toasts";
import { RenderOrigin } from "@plugins/primitives/plugins/scope/plugins/render-origin/web";
import {
  ANNOUNCEMENT_DURATION_MS,
  useShowCustomToast,
  type CustomToastArgs,
} from "../internal/show-toast";

/** sonner's default toast lifetime (dist:417). */
const TOAST_LIFETIME = 4000;
/** sonner's exit-animation window between removal and unmount (dist:425). */
const TIME_BEFORE_UNMOUNT = 200;

/** A text-only reply, alive for sonner's default lifetime. */
function textToast(text: string): CustomToastArgs {
  return {
    kind: "reply",
    duration: TOAST_LIFETIME,
    render: () => <span>{text}</span>,
  };
}

function LedgerProbe() {
  const count = useLiveToastCount();
  return <div data-testid="ledger-count">{count}</div>;
}

/** The raiser of the mounted tree, captured by `Raiser`. */
let show: ((args: CustomToastArgs) => void) | null = null;
function Raiser() {
  const raise = useShowCustomToast();
  // Published after commit, never assigned during render.
  useEffect(() => {
    show = raise;
  }, [raise]);
  return null;
}

/** Toaster-optional tree, so a rerender can mount or unmount the host under a live probe. */
function Harness({ toaster }: { toaster: boolean }) {
  return (
    <RenderOrigin>
      <LedgerProbe />
      <Raiser />
      {toaster ? <Toaster /> : null}
    </RenderOrigin>
  );
}

/** Fires one toast from a passive effect, the shape the real bell button has. */
function ToastOnMount({ text }: { text: string }) {
  const raise = useShowCustomToast();
  useEffect(() => {
    raise(textToast(text));
  }, [raise, text]);
  return null;
}

function ledgerCount(): number {
  return Number(screen.getByTestId("ledger-count").textContent);
}

function mountedToasts(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-sonner-toast]"));
}

/**
 * Drive every asynchronous hop between a raise and the DOM settling:
 *
 *  1. the content committing in its origin, then our own `queueMicrotask`
 *     deferral — drained by the `await`s below;
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
    await Promise.resolve();
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
  });
}

/** Raise each toast from outside React (an event handler's shape), then settle. */
async function raise(...toasts: CustomToastArgs[]): Promise<void> {
  await act(async () => {
    for (const args of toasts) show!(args);
    // The content commits in the origin before the toast is enqueued.
    await Promise.resolve();
  });
  await flushToasts();
}

beforeEach(() => {
  show = null;
  vi.useFakeTimers({
    // `requestAnimationFrame` is load-bearing here, not incidental: every
    // dismissal hops through one, so under a frozen clock with a real rAF the
    // toast never leaves and the dismiss cases hang on an <li> that will not go
    // away. `queueMicrotask` is deliberately NOT faked — `showCustomToast`'s
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
    render(<Harness toaster />);

    // Five, deliberately past sonner's `visibleToasts` default of 3: it mounts
    // all of them and only drives opacity, and sweeping the ones you cannot see
    // is the whole justification for the affordance this count feeds.
    await raise(...[1, 2, 3, 4, 5].map((n) => textToast(`toast ${n}`)));

    const mounted = mountedToasts().length;
    expect(mounted).toBe(5);
    expect(ledgerCount()).toBe(mounted);
  });

  it("does not count a toast no <Toaster/> ever rendered (defect A)", async () => {
    // REGRESSION. The old ledger recorded at enqueue time and retired only from
    // sonner's exit callbacks, so an enqueue with no renderer was counted
    // forever with no repair path: the empty corner under a "Dismiss all (3)".
    render(<Harness toaster={false} />);

    await raise(...[1, 2, 3, 4, 5].map((n) => textToast(`orphan ${n}`)));

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
      <RenderOrigin>
        <LedgerProbe />
        <ToastOnMount text="from an effect" />
        <Toaster />
      </RenderOrigin>,
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
    await raise(textToast("before the host"));
    expect(mountedToasts()).toHaveLength(0);

    rerender(<Harness toaster />);
    await flushToasts();

    expect(mountedToasts()).toHaveLength(1);
    expect(ledgerCount()).toBe(1);
    expect(screen.getByText("before the host")).toBeTruthy();
  });

  it("never enqueues inside the caller's stack", async () => {
    // The deferral, observed directly at sonner's own boundary rather than
    // through the DOM: nothing reaches `ToastState` inside the caller's stack.
    render(<Harness toaster />);
    const before = sonnerToast.getHistory().length;

    act(() => show!(textToast("deferred")));
    expect(sonnerToast.getHistory()).toHaveLength(before);

    await flushToasts();
    expect(sonnerToast.getHistory()).toHaveLength(before + 1);
  });

  it("keeps an exiting toast counted for its exit animation, then drops it", async () => {
    render(<Harness toaster />);

    await raise(textToast("expires a"), textToast("expires b"));
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

    await raise(textToast("host goes away a"), textToast("host goes away b"));
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
});

describe("click-to-dismiss", () => {
  /** A custom toast with words and one control of its own, kept until handled. */
  async function showCustom(onControl: () => void): Promise<void> {
    render(<Harness toaster />);
    await raise({
      kind: "reply",
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

describe("a custom toast renders in its caller's origin", () => {
  /** Stands for any context the toast's body reads (a transport, a navigator). */
  const World = createContext("page");

  function WorldName() {
    return <p>{`body in ${useContext(World)}`}</p>;
  }

  /** The toaster in the page's world; the raiser in its own origin, in another. */
  function Tree({ withOrigin }: { withOrigin: boolean }) {
    return (
      <>
        <LedgerProbe />
        <Toaster />
        {withOrigin && (
          <World.Provider value="demo">
            <RenderOrigin>
              <Raiser />
            </RenderOrigin>
          </World.Provider>
        )}
      </>
    );
  }

  const worldToast: CustomToastArgs = {
    kind: "reply",
    duration: Infinity,
    render: () => <WorldName />,
  };

  it("shows the body inside the toast, reading the caller's contexts", async () => {
    render(<Tree withOrigin />);
    await raise(worldToast);
    const [li] = mountedToasts();
    expect(li?.textContent).toContain("body in demo");
    expect(ledgerCount()).toBe(1);
  });

  it("is dismissed when its origin goes away", async () => {
    const view = render(<Tree withOrigin />);
    await raise(worldToast);
    expect(mountedToasts()).toHaveLength(1);
    view.rerender(<Tree withOrigin={false} />);
    await flushToasts(50);
    await flushToasts(TIME_BEFORE_UNMOUNT + 50);
    expect(mountedToasts()).toHaveLength(0);
    expect(ledgerCount()).toBe(0);
  });
});

describe("an announcement is never sticky", () => {
  /*
   * An announcement is something that happened on its own (a notification
   * arriving): its record is its persistent surface (the bell), so the toast
   * leaves after the announcement duration whatever it says, and a page off
   * screen never raises one — sonner would keep it mounted until shown.
   */

  it("an announcement leaves after the announcement duration", async () => {
    render(<Harness toaster />);
    await raise({ kind: "announcement", render: () => <p>arrived</p> });
    expect(mountedToasts()).toHaveLength(1);
    await flushToasts(ANNOUNCEMENT_DURATION_MS);
    await flushToasts(TIME_BEFORE_UNMOUNT + 50);
    expect(mountedToasts()).toHaveLength(0);
    expect(ledgerCount()).toBe(0);
  });

  it("a reply may stay until handled", async () => {
    render(<Harness toaster />);
    await raise({
      kind: "reply",
      duration: Infinity,
      render: () => <p>save failed</p>,
    });
    await flushToasts(ANNOUNCEMENT_DURATION_MS * 10);
    expect(mountedToasts()).toHaveLength(1);
  });

  it("a page off screen raises no announcement — a reply still shows", async () => {
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    try {
      render(<Harness toaster />);
      await raise({ kind: "announcement", render: () => <p>arrived</p> });
      expect(mountedToasts()).toHaveLength(0);
      await raise(textToast("copied"));
      expect(mountedToasts()).toHaveLength(1);
    } finally {
      visibility.mockRestore();
    }
  });
});
