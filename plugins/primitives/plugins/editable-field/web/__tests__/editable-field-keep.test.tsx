/**
 * `useEditableField`'s `keep`: text no save has taken yet is kept-state work,
 * so a remount (a reload, a tab switch) gives it back and resumes its save —
 * or reports a conflict when the source moved on meanwhile — and a resolved
 * save clears it.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  installStorage,
  QuotaStorage,
} from "@plugins/primitives/plugins/dom/plugins/web-storage/web/testing";
import { flushKept } from "@plugins/primitives/plugins/kept-state/web";
import { transient } from "@plugins/primitives/plugins/kept-state/core";
import { useEditableField } from "../use-editable-field";

let local: QuotaStorage;
beforeAll(() => {
  local = new QuotaStorage();
  installStorage("local", local);
  installStorage("session", new QuotaStorage());
});

let n = 0;
const subject = () => `rec-${++n}`;

function pendingEntries(): number {
  let count = 0;
  for (let i = 0; i < local.length; i++)
    if (local.key(i)!.includes("editable-field.pending")) count++;
  return count;
}

function mount(
  value: string,
  onSave: (next: string) => void | Promise<void>,
  keep: { field: string; subject: string } | ReturnType<typeof transient>,
) {
  return renderHook(
    ({ value }: { value: string }) =>
      useEditableField({ value, onSave, debounceMs: 20, keep }),
    { initialProps: { value } },
  );
}

describe("kept pending text", () => {
  it("gives back unsaved text after a remount and resumes its save", async () => {
    const keep = { field: "test.title", subject: subject() };
    const first = mount("old", vi.fn(), keep);
    act(() => first.result.current.onChange("half typed"));
    flushKept();
    first.unmount(); // inside the debounce window: the save never ran

    const onSave = vi.fn();
    const second = mount("old", onSave, keep);
    expect(second.result.current.value).toBe("half typed");
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("half typed"));
    await waitFor(() => expect(pendingEntries()).toBe(0));
  });

  it("reports a conflict when the source moved on since", () => {
    const keep = { field: "test.title", subject: subject() };
    const first = mount("old", vi.fn(), keep);
    act(() => first.result.current.onChange("mine"));
    flushKept();
    first.unmount();

    const onSave = vi.fn();
    const second = mount("theirs", onSave, keep);
    expect(second.result.current.value).toBe("mine");
    expect(second.result.current.conflict).toEqual({ external: "theirs" });
    act(() => second.result.current.acceptExternal());
    expect(second.result.current.value).toBe("theirs");
    expect(pendingEntries()).toBe(0);
  });

  it("keeps the text when the save fails", async () => {
    const keep = { field: "test.title", subject: subject() };
    const onSave = vi.fn(() => Promise.reject(new Error("offline")));
    const { result } = mount("old", onSave, keep);
    act(() => result.current.onChange("draft"));
    await act(async () => {
      await expect(result.current.flush()).rejects.toThrow("offline");
    });
    expect(result.current.isError).toBe(true);
    flushKept();
    expect(pendingEntries()).toBe(1);
  });

  it("a second field mounted beside the one being typed in does not take its text", async () => {
    const keep = { field: "test.title", subject: subject() };
    const a = mount("ab", vi.fn(), keep);
    act(() => a.result.current.onChange("abc"));
    flushKept();

    const onSaveB = vi.fn();
    const b = mount("ab", onSaveB, keep);
    expect(b.result.current.value).toBe("ab");
    // B adopting a value must not clear A's unsaved text.
    b.rerender({ value: "ab2" });
    flushKept();
    expect(pendingEntries()).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 60));
    expect(onSaveB).not.toHaveBeenCalled();
    a.unmount();
    b.unmount();
  });

  it("keeps nothing for a transient field", () => {
    const before = pendingEntries();
    const { result } = mount("old", vi.fn(), transient("test"));
    act(() => result.current.onChange("draft"));
    flushKept();
    expect(pendingEntries()).toBe(before);
  });
});
