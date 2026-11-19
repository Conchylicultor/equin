import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { usePageShortcuts } from "../internal/use-page-shortcuts";
import { useDynamicShortcuts } from "../internal/dynamic-registry";
import type { ShortcutDescriptor } from "../internal/types";

afterEach(cleanup);

/** Every registry snapshot the registry handed out, one per change. */
function RegistryProbe({ seen }: { seen: ShortcutDescriptor[][] }) {
  const snapshot = useDynamicShortcuts();
  if (seen.at(-1) !== snapshot) seen.push(snapshot);
  return null;
}

function Caller({ label, onFire }: { label: string; onFire: () => void }) {
  // A fresh array and fresh closures on every render, never memoized.
  usePageShortcuts([
    { id: "test.esc", keys: "Escape", label, handler: () => onFire() },
  ]);
  return null;
}

describe("registered shortcuts", () => {
  it("re-renders with fresh closures do not re-register", () => {
    const seen: ShortcutDescriptor[][] = [];
    const first = vi.fn();
    const { rerender } = render(
      <>
        <RegistryProbe seen={seen} />
        <Caller label="Close" onFire={first} />
      </>,
    );
    const registered = seen.length;
    const second = vi.fn();
    for (let i = 0; i < 5; i++) {
      rerender(
        <>
          <RegistryProbe seen={seen} />
          <Caller label="Close" onFire={second} />
        </>,
      );
    }
    expect(seen.length).toBe(registered);
    // The registered handler runs the latest render's closure.
    act(() =>
      seen
        .at(-1)!
        .find((s) => s.id === "test.esc")!
        .handler(),
    );
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("re-registers when what the shortcut is changes", () => {
    const seen: ShortcutDescriptor[][] = [];
    const { rerender } = render(
      <>
        <RegistryProbe seen={seen} />
        <Caller label="Close" onFire={() => {}} />
      </>,
    );
    const registered = seen.length;
    rerender(
      <>
        <RegistryProbe seen={seen} />
        <Caller label="Dismiss" onFire={() => {}} />
      </>,
    );
    expect(seen.length).toBeGreaterThan(registered);
    expect(seen.at(-1)!.find((s) => s.id === "test.esc")!.label).toBe(
      "Dismiss",
    );
  });

  it("a registration outlived by its shape calls its own closure", () => {
    // A key landing between a render that dropped the shortcut and the
    // commit that unregisters it still reaches the registration made before.
    const seen: ShortcutDescriptor[][] = [];
    const fire = vi.fn();
    function Toggle({ on }: { on: boolean }) {
      usePageShortcuts(
        on
          ? [{ id: "test.zoom", keys: "Escape", label: "Leave", handler: fire }]
          : [],
      );
      return null;
    }
    const { rerender } = render(
      <>
        <RegistryProbe seen={seen} />
        <Toggle on />
      </>,
    );
    const stale = seen.at(-1)!.find((s) => s.id === "test.zoom")!;
    rerender(
      <>
        <RegistryProbe seen={seen} />
        <Toggle on={false} />
      </>,
    );
    expect(seen.at(-1)!.some((s) => s.id === "test.zoom")).toBe(false);
    expect(() => stale.handler()).not.toThrow();
    expect(fire).toHaveBeenCalledTimes(1);
  });
});
