/**
 * Hook-shell tests for `useEditableField`. The reconcile POLICY is pinned as
 * pure logic by `internal/reconcile.test.ts` (bun:test); what only a render can
 * exercise is the WIRING: that an external write reaches a focused field, that
 * the draft a user is typing is never yanked away, that the divergence reaches
 * the sync-status cloud, that a blur can no longer flush a stale draft over a
 * newer external value, and that the caret survives an adoption.
 *
 * The historical defect these cover: the value-sync effect returned early
 * whenever the field had focus, so an agent's rename / another tab / an undo
 * patch was silently discarded and then overwritten on the next blur.
 */

import { describe, expect, it, vi } from "vitest";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import {
  SyncStatusIndicator,
  SyncStatusProvider,
} from "@plugins/primitives/plugins/sync-status/web";
import { useEditableField } from "../use-editable-field";

/** Render the hook over a changeable external `value`, as a live-state consumer does. */
function renderField(opts: {
  value: string;
  onSave: (next: string) => void | Promise<void>;
  debounceMs?: number;
}) {
  return renderHook(
    ({ value }: { value: string }) =>
      useEditableField({
        value,
        onSave: opts.onSave,
        debounceMs: opts.debounceMs ?? 20,
        label: "Title",
      }),
    { initialProps: { value: opts.value } },
  );
}

describe("external writes while focused", () => {
  it("adopts an external write when the draft has nothing unsaved", async () => {
    const onSave = vi.fn();
    const { result, rerender } = renderField({ value: "old", onSave });

    act(() => result.current.onFocus());
    rerender({ value: "renamed by an agent" });

    expect(result.current.value).toBe("renamed by an agent");
    expect(result.current.conflict).toBeNull();

    // The adopted value is the saved value, so blurring writes nothing back.
    await act(async () => result.current.onBlur());
    expect(onSave).not.toHaveBeenCalled();
  });

  it("keeps a draft with unsaved edits and reports the conflict", () => {
    const onSave = vi.fn();
    const { result, rerender } = renderField({
      value: "old",
      onSave,
      debounceMs: 10_000, // no save fires during the test
    });

    act(() => result.current.onFocus());
    act(() => result.current.onChange("mine"));
    rerender({ value: "theirs" });

    expect(result.current.value).toBe("mine");
    expect(result.current.conflict).toEqual({ external: "theirs" });
  });

  it("clears the conflict once the two sides agree again", () => {
    const onSave = vi.fn();
    const { result, rerender } = renderField({
      value: "old",
      onSave,
      debounceMs: 10_000,
    });

    act(() => result.current.onFocus());
    act(() => result.current.onChange("mine"));
    rerender({ value: "theirs" });
    expect(result.current.conflict).not.toBeNull();

    // The user types their way to exactly the external value.
    act(() => result.current.onChange("theirs"));
    expect(result.current.conflict).toBeNull();
  });

  it("acceptExternal takes the external value and cancels the pending save", async () => {
    const onSave = vi.fn();
    const { result, rerender } = renderField({ value: "old", onSave });

    act(() => result.current.onFocus());
    act(() => result.current.onChange("mine"));
    rerender({ value: "theirs" });
    act(() => result.current.acceptExternal());

    expect(result.current.value).toBe("theirs");
    expect(result.current.conflict).toBeNull();

    await new Promise((r) => setTimeout(r, 60));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("still adopts an external write while unfocused", () => {
    const { result, rerender } = renderField({ value: "old", onSave: vi.fn() });
    rerender({ value: "new" });
    expect(result.current.value).toBe("new");
  });
});

describe("stale echoes of the field's own past", () => {
  it("never puts deleted text back when the source briefly shows the pre-save value", async () => {
    const onSave = vi.fn();
    const { result, rerender } = renderField({
      value: "abc",
      onSave,
      debounceMs: 5,
    });

    act(() => result.current.onFocus());
    act(() => result.current.onChange("ab")); // delete "c"
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(onSave).toHaveBeenCalledWith("ab");

    // The write's prediction, then an older view of the source, then its echo.
    rerender({ value: "ab" });
    rerender({ value: "abc" });
    expect(result.current.value).toBe("ab");
    expect(result.current.conflict).toBeNull();
    rerender({ value: "ab" });
    expect(result.current.value).toBe("ab");
  });

  it("still saves a draft typed back to an old value when a stale echo of it lands", async () => {
    const onSave = vi.fn();
    const { result, rerender } = renderField({
      value: "a",
      onSave,
      debounceMs: 5,
    });

    act(() => result.current.onFocus());
    act(() => result.current.onChange("ab"));
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    rerender({ value: "ab" });

    act(() => result.current.onChange("a")); // typed back, not saved yet
    rerender({ value: "a" }); // a stale view of the seed
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(onSave).toHaveBeenLastCalledWith("a");
  });

  it("takes an old value again once someone else has moved the source", async () => {
    const { result, rerender } = renderField({
      value: "a",
      onSave: vi.fn(),
      debounceMs: 5,
    });

    act(() => result.current.onChange("b"));
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    rerender({ value: "b" });
    rerender({ value: "c" }); // another writer: the new baseline
    expect(result.current.value).toBe("c");
    rerender({ value: "a" }); // a real write that happens to spell "a"
    expect(result.current.value).toBe("a");
  });
});

describe("save lifecycle", () => {
  it("debounces a typing run into one save", async () => {
    const onSave = vi.fn();
    const { result } = renderField({ value: "", onSave });

    act(() => result.current.onChange("a"));
    act(() => result.current.onChange("ab"));
    act(() => result.current.onChange("abc"));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith("abc");
  });

  it("flushes the pending draft on blur", async () => {
    const onSave = vi.fn();
    const { result } = renderField({ value: "", onSave, debounceMs: 10_000 });

    act(() => result.current.onFocus());
    act(() => result.current.onChange("typed"));
    await act(async () => result.current.onBlur());

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith("typed");
  });

  it("suppresses the echo of its own save", async () => {
    const onSave = vi.fn();
    const { result, rerender } = renderField({ value: "", onSave });

    act(() => result.current.onFocus());
    act(() => result.current.onChange("abc"));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));

    // The user keeps typing while the server echoes what we just saved.
    act(() => result.current.onChange("abcd"));
    rerender({ value: "abc" });

    expect(result.current.value).toBe("abcd");
    expect(result.current.conflict).toBeNull();
  });

  it("reports the failed save as an error, not as a conflict", async () => {
    const onSave = vi.fn(() => Promise.reject(new Error("nope")));
    const { result } = renderField({ value: "", onSave, debounceMs: 10_000 });

    act(() => result.current.onFocus());
    act(() => result.current.onChange("typed"));
    await act(async () => {
      await expect(result.current.flush()).rejects.toThrow("nope");
    });

    expect(result.current.isError).toBe(true);
    expect(result.current.conflict).toBeNull();
  });
});

/** A field bound to a real input, so the DOM caret is observable. */
function Field({ value }: { value: string }) {
  const field = useEditableField({
    value,
    onSave: () => {},
    debounceMs: 10_000,
    label: "Title",
  });
  return (
    <input
      aria-label="title"
      value={field.value}
      onChange={(e) => field.onChange(e.target.value)}
      onFocus={field.onFocus}
      onBlur={field.onBlur}
    />
  );
}

describe("caret", () => {
  it("keeps the caret over the same text when an external value is adopted", () => {
    const { rerender, getByLabelText } = render(<Field value="bc" />);
    const el = getByLabelText("title") as HTMLInputElement;

    act(() => el.focus());
    el.setSelectionRange(1, 1); // between "b" and "c"

    rerender(<Field value="abc" />);

    expect(el.value).toBe("abc");
    // Raw offset restoration would leave it at 1 (between "a" and "b"); the
    // caret belongs after the "b" it was sitting behind.
    expect(el.selectionStart).toBe(2);
    expect(el.selectionEnd).toBe(2);
  });
});

describe("sync-status", () => {
  it("surfaces a divergence on the surface's cloud", async () => {
    function Conflicting({ value }: { value: string }) {
      const field = useEditableField({
        value,
        onSave: () => {},
        debounceMs: 10_000,
        label: "Task title",
      });
      return (
        <button
          type="button"
          onClick={() => field.onChange("mine")}
          data-testid="type"
        >
          {field.value}
        </button>
      );
    }

    const { container, rerender, getByTestId } = render(
      <SyncStatusProvider>
        <Conflicting value="old" />
        <SyncStatusIndicator />
      </SyncStatusProvider>,
    );
    expect(container.querySelector(".text-warning")).toBeNull();

    act(() => getByTestId("type").click());
    rerender(
      <SyncStatusProvider>
        <Conflicting value="theirs" />
        <SyncStatusIndicator />
      </SyncStatusProvider>,
    );

    await waitFor(() =>
      expect(container.querySelector(".text-warning")).not.toBeNull(),
    );
  });
});
