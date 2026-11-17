import { act, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useReducer, useState } from "react";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  installStorage,
  QuotaStorage,
} from "@plugins/primitives/plugins/dom/plugins/web-storage/web/testing";
import {
  defineKept,
  KeepScope,
  onKeepScopeUnmount,
  useKept,
  useTransient,
  type KeepScopeUnmount,
} from "@plugins/primitives/plugins/kept-state/web";
import {
  collectLosses,
  createCommitAttribution,
  isUserData,
  isUserEvent,
  observeCommit,
  previewValue,
  type StateLoss,
} from "../internal/detector";
import {
  asFiber,
  committedFiber,
  COMPONENT_SOURCE_PROP,
  type Fiber,
} from "../internal/fiber";

beforeAll(() => {
  installStorage("local", new QuotaStorage());
  installStorage("session", new QuotaStorage());
});

const viewQuery = defineKept({
  owner: "test.loss-detector.query",
  tier: "view",
  schema: z.string(),
});

// Each kind of state, changed by a click on its own button (as a user would),
// except `loaded`, changed by an effect once `load` is set (as data would).
function Surface() {
  const [typed, setTyped] = useState("");
  const [hover, setHover] = useTransient("hover: gone with the pointer", false);
  const [kept, setKept] = useKept(viewQuery, "");
  const [load, setLoad] = useState(false);
  const [loaded, setLoaded] = useState(0);
  const [count, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!load) return;
    void Promise.resolve(42).then(setLoaded);
  }, [load]);
  return (
    <p data-source="plugins/x/web/surface.tsx:12">
      <button onClick={() => setTyped("half a sentence")}>type</button>
      <button onClick={() => setTyped("")}>clear</button>
      <button onClick={() => setHover(true)}>hover</button>
      <button onClick={() => setKept("query")}>keep</button>
      <button onClick={() => bump()}>bump</button>
      <button onClick={() => setLoad(true)}>load</button>
      {typed}
      {String(hover)}
      {kept}
      {loaded}
      {count}
    </p>
  );
}

// A library's component (no build stamp: node_modules never goes through the
// build's Babel pass): its own state, flipped by a click, is not the repo's
// to keep.
function LibraryToggle() {
  const [on, setOn] = useState(false);
  return (
    <button onClick={() => setOn(true)}>{on ? "library on" : "library"}</button>
  );
}

// React's "adjust state when a prop changes" pattern: `prev` mirrors the
// `items` prop, so it changes with every new `items` — in a click's commit too.
function Mirror({ items }: { items: string[] }) {
  const [prev, setPrev] = useState(items);
  if (prev !== items) setPrev(items);
  return <span>{prev.length}</span>;
}

// Not stamped: its `items` is the user's change, a real loss of its own.
function MirrorHost() {
  const [items, setItems] = useState<string[]>([]);
  return (
    <>
      <button onClick={() => setItems(["a"])}>add</button>
      <Mirror items={items} />
    </>
  );
}

// What the build's stamp (`vite/index.ts`) adds after a repo component.
function stampAsRepo(component: object, file: string): void {
  Object.assign(component, { [COMPONENT_SOURCE_PROP]: file });
}
stampAsRepo(Surface, "src/surface.tsx");
stampAsRepo(Mirror, "src/mirror.tsx");

const click = (name: string) =>
  fireEvent.click(screen.getByRole("button", { name }));

function hostRoot(container: HTMLElement): Fiber {
  const key = Object.keys(container).find((k) =>
    k.startsWith("__reactContainer$"),
  );
  const fiber = asFiber(
    key ? (container as unknown as Record<string, unknown>)[key] : null,
  );
  if (fiber === null) throw new Error("no React root on the container");
  return committedFiber(fiber);
}

describe("loss-detector", () => {
  it("reports user-changed plain state of repo components only — kept, transient, data-driven and library state are not losses", async () => {
    const baselines = new WeakMap<
      object,
      { baseline: unknown; last: unknown }
    >();
    const { container, unmount } = render(
      <KeepScope segment="t:tab-1">
        <Surface />
        <LibraryToggle />
      </KeepScope>,
    );
    const observe = (userInput: boolean) =>
      observeCommit(hostRoot(container), baselines, userInput);
    observe(false); // the mount: baselines

    // Data arriving (`load` is the user's; `loaded`, set later by an effect,
    // is not): observed outside any input, so its baseline moves.
    act(() => {
      click("load");
    });
    observe(true);
    await act(async () => {
      await Promise.resolve();
    });
    observe(false);

    act(() => {
      click("type");
      click("hover");
      click("keep");
      click("bump");
      click("library");
    });
    observe(true);

    let losses: StateLoss[] = [];
    const stop = onKeepScopeUnmount((u: KeepScopeUnmount) => {
      const probe = asFiber(u.fiber);
      if (probe)
        losses = collectLosses(committedFiber(probe), u.path, baselines);
    });
    unmount();
    stop();

    expect(losses.map((l) => [l.component, l.stateIndex, l.value])).toEqual([
      ["Surface", 0, "string(15)"],
      ["Surface", 4, "boolean true"],
      ["Surface", 6, "number 1"],
    ]);
    expect(losses[0]).toMatchObject({
      scope: "t:tab-1",
      source: "plugins/x/web/surface.tsx:12",
    });
  });

  it("a user change reverted before the unmount is no loss", () => {
    const baselines = new WeakMap<
      object,
      { baseline: unknown; last: unknown }
    >();
    const { container, unmount } = render(
      <KeepScope segment="t:tab-2">
        <Surface />
      </KeepScope>,
    );
    observeCommit(hostRoot(container), baselines, false);
    act(() => {
      click("type");
    });
    observeCommit(hostRoot(container), baselines, true);
    act(() => {
      click("clear");
    });
    observeCommit(hostRoot(container), baselines, true);

    let losses: StateLoss[] | null = null;
    const stop = onKeepScopeUnmount((u) => {
      const probe = asFiber(u.fiber);
      if (probe)
        losses = collectLosses(committedFiber(probe), u.path, baselines);
    });
    unmount();
    stop();
    expect(losses).toEqual([]);
  });

  it("a state set to a prop handed in anew mirrors it: not the user's, even in a click's commit", () => {
    const baselines = new WeakMap<
      object,
      { baseline: unknown; last: unknown }
    >();
    const { container, unmount } = render(
      <KeepScope segment="t:tab-3">
        <MirrorHost />
      </KeepScope>,
    );
    observeCommit(hostRoot(container), baselines, false);
    act(() => {
      click("add");
    });
    observeCommit(hostRoot(container), baselines, true);

    let losses: StateLoss[] | null = null;
    const stop = onKeepScopeUnmount((u) => {
      const probe = asFiber(u.fiber);
      if (probe)
        losses = collectLosses(committedFiber(probe), u.path, baselines);
    });
    unmount();
    stop();
    expect(losses).toEqual([]);
  });

  // jsdom cannot replay the real premise (a script-dispatched event has no
  // microtask checkpoint while it is current), so this drives the attribution
  // as the commit bridge would call it.
  it("a commit inside a user commit's own flush is its cascade; the next listener's commit is the user's again", async () => {
    const byUser = createCommitAttribution();
    const click = new MouseEvent("click");
    expect(byUser(click)).toBe(true); // the capture listener's commit
    expect(byUser(click)).toBe(false); // a layout effect's re-render, same flush
    await Promise.resolve();
    expect(byUser(click)).toBe(true); // the bubble listener's commit
    await Promise.resolve();
    expect(byUser(new MouseEvent("mouseenter"))).toBe(false);
    expect(byUser(undefined)).toBe(false);
  });

  it("previews a value by its shape, not its content", () => {
    expect(previewValue("secret text")).toBe("string(11)");
    expect(previewValue([1, 2])).toBe("array(2)");
    expect(previewValue({ a: 1, b: 2 })).toBe("object {a, b}");
    expect(previewValue(new Set([1]))).toBe("Set(1)");
    expect(previewValue(true)).toBe("boolean true");
  });

  it("judges only data: a DOM node, a function or an object holding one is wiring", () => {
    expect(isUserData("text")).toBe(true);
    expect(isUserData({ x: 1, y: 2 })).toBe(true);
    expect(isUserData([1, 2])).toBe(true);
    expect(isUserData(document.createElement("div"))).toBe(false);
    expect(isUserData(() => 1)).toBe(false);
    expect(isUserData({ contextElement: document.body, n: 1 })).toBe(false);
    expect(isUserData({ getBoundingClientRect: () => null })).toBe(false);
  });

  it("a user event is a key, a press, a click, text or a drag — not hover, focus or scroll", () => {
    expect(isUserEvent(undefined)).toBe(false);
    expect(isUserEvent(new MouseEvent("click"))).toBe(true);
    expect(isUserEvent(new KeyboardEvent("keydown"))).toBe(true);
    expect(isUserEvent(new Event("input"))).toBe(true);
    expect(isUserEvent(new MouseEvent("mousemove", { buttons: 1 }))).toBe(true);
    expect(isUserEvent(new MouseEvent("mousemove"))).toBe(false);
    expect(isUserEvent(new MouseEvent("mouseenter"))).toBe(false);
    expect(isUserEvent(new FocusEvent("focusin"))).toBe(false);
    expect(isUserEvent(new Event("scroll"))).toBe(false);
  });
});
