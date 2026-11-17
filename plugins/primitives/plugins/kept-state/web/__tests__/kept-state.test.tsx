import { act, render, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  installStorage,
  QuotaStorage,
  storageScopeOf,
} from "@plugins/primitives/plugins/dom/plugins/web-storage/web/testing";
import { defineKept } from "../define-kept";
import { flushKept, readDraft } from "../draft-storage";
import { forgetKeepScope, KeepScope } from "../keep-scope";
import { submitKept } from "../submit-kept";
import { useKept } from "../use-kept";
import type { KeptBinding } from "../use-draft";

let local: QuotaStorage;
let session: QuotaStorage;
beforeAll(() => {
  local = new QuotaStorage();
  session = new QuotaStorage();
  installStorage("local", local);
  installStorage("session", session);
});

let n = 0;
/** Owners live in a module registry: every test declares fresh ones. */
const owner = (name: string) => `test.${name}-${++n}`;

function work(name: string) {
  return defineKept({
    owner: owner(name),
    label: "Test drafts",
    tier: "work",
    cap: "8 KB",
    schema: z.string(),
  });
}

/** Every local-storage value of `owner`'s entries, by key. */
function stored(area: QuotaStorage, ownerId: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < area.length; i++) {
    const key = area.key(i)!;
    if (key.includes(ownerId))
      out[key] = (JSON.parse(area.getItem(key)!) as { v: unknown }).v;
  }
  return out;
}

describe("useKept — work", () => {
  it("batches writes to the end of the frame, flushKept writes them, a remount reads them back", () => {
    const kept = work("rt");
    const first = renderHook(() => useKept(kept, "", { subject: "conv-1" }));
    act(() => first.result.current[1]("hel"));
    act(() => first.result.current[1]("hello"));
    // Not in storage yet, but every read sees it.
    expect(stored(local, kept.owner)).toEqual({});
    first.unmount();
    flushKept();
    expect(Object.values(stored(local, kept.owner))).toEqual(["hello"]);

    const again = renderHook(() => useKept(kept, "", { subject: "conv-1" }));
    expect(again.result.current[0]).toBe("hello");
    const other = renderHook(() => useKept(kept, "", { subject: "conv-2" }));
    expect(other.result.current[0]).toBe("");
  });

  it("refuses a work owner without a subject", () => {
    const kept = work("nosubject");
    expect(() =>
      renderHook(() =>
        // @ts-expect-error — the work tier requires a subject
        useKept(kept, ""),
      ),
    ).toThrow(/needs a subject/);
  });
});

describe("useKept — view", () => {
  const view = (name: string) =>
    defineKept({ owner: owner(name), tier: "view", schema: z.string() });

  const inPane =
    (tab: string, pane: string) =>
    ({ children }: { children: ReactNode }) => (
      <KeepScope segment={`t:${tab}`}>
        <KeepScope segment={`p:${pane}`}>{children}</KeepScope>
      </KeepScope>
    );

  it("is keyed by the KeepScope path and survives a remount in the same place", () => {
    const query = view("query");
    const a = renderHook(() => useKept(query, ""), {
      wrapper: inPane("tab1", "pane1"),
    });
    act(() => a.result.current[1]("needle"));
    a.unmount();
    flushKept();

    const same = renderHook(() => useKept(query, ""), {
      wrapper: inPane("tab1", "pane1"),
    });
    expect(same.result.current[0]).toBe("needle");
    const otherPane = renderHook(() => useKept(query, ""), {
      wrapper: inPane("tab1", "pane2"),
    });
    expect(otherPane.result.current[0]).toBe("");
  });

  it("is memory only outside every KeepScope", () => {
    const query = view("unscoped");
    const a = renderHook(() => useKept(query, ""));
    act(() => a.result.current[1]("lost"));
    expect(a.result.current[0]).toBe("lost");
    a.unmount();
    flushKept();
    expect(stored(session, query.owner)).toEqual({});
    const again = renderHook(() => useKept(query, ""));
    expect(again.result.current[0]).toBe("");
  });

  it("does not restore an entry its schema no longer reads", () => {
    const loose = defineKept({
      owner: owner("schema"),
      tier: "view",
      schema: z.unknown(),
    });
    const strict = { ...loose, schema: z.number() };
    const a = renderHook(() => useKept(loose, "" as unknown), {
      wrapper: inPane("tab9", "pane9"),
    });
    act(() => a.result.current[1]("a string"));
    a.unmount();
    flushKept();
    const b = renderHook(() => useKept(strict, 7), {
      wrapper: inPane("tab9", "pane9"),
    });
    expect(b.result.current[0]).toBe(7);
  });

  it("forgetKeepScope drops a closed place's state and its nested places'", () => {
    const query = view("forget");
    for (const [tab, pane] of [
      ["tabA", "p1"],
      ["tabA", "p2"],
      ["tabB", "p3"],
    ] as const) {
      const h = renderHook(() => useKept(query, ""), {
        wrapper: inPane(tab, pane),
      });
      act(() => h.result.current[1](`${tab}/${pane}`));
      h.unmount();
    }
    flushKept();
    expect(Object.keys(stored(session, query.owner))).toHaveLength(3);

    forgetKeepScope("p:p1");
    expect(Object.values(stored(session, query.owner)).sort()).toEqual([
      "tabA/p2",
      "tabB/p3",
    ]);
    forgetKeepScope("t:tabA");
    expect(Object.values(stored(session, query.owner))).toEqual(["tabB/p3"]);
  });

  it("refuses a malformed segment", () => {
    expect(() =>
      render(
        <KeepScope segment="t:a/b">
          <span />
        </KeepScope>,
      ),
    ).toThrow(/must match/);
  });
});

describe("submitKept", () => {
  /** A send the test settles by hand. */
  function deferred() {
    let resolve!: (r: { ok: boolean }) => void;
    const promise = new Promise<{ ok: boolean }>((r) => (resolve = r));
    return { promise, resolve };
  }

  function mount(kept: ReturnType<typeof work>) {
    return renderHook(() => useKept(kept, "", { subject: "s" }));
  }
  const handleOf = (b: KeptBinding<string>) => b[3];
  const storedValue = (kept: ReturnType<typeof work>) =>
    readDraft(kept.store.in(storageScopeOfPage()), { scope: "s" });

  it("keeps the entry (and what is shown) until the send resolves ok", async () => {
    const kept = work("ack");
    const h = mount(kept);
    act(() => h.result.current[1]("ship it"));
    const send = deferred();
    let done!: Promise<{ ok: boolean }>;
    act(() => {
      done = submitKept(handleOf(h.result.current), () => send.promise);
    });
    // Flushed at submit: a reload now restores it.
    expect(Object.values(stored(local, kept.owner))).toEqual(["ship it"]);
    expect(h.result.current[0]).toBe("ship it");
    await act(async () => {
      send.resolve({ ok: true });
      await done;
    });
    expect(storedValue(kept)).toBeNull();
    expect(h.result.current[0]).toBe("");
  });

  it("leaves the entry when the send is refused", async () => {
    const kept = work("refused");
    const h = mount(kept);
    act(() => h.result.current[1]("try again"));
    await act(async () => {
      await submitKept(handleOf(h.result.current), async () => ({
        ok: false,
      }));
    });
    expect(storedValue(kept)).toBe("try again");
    expect(h.result.current[0]).toBe("try again");
  });

  it("at-once: empties the field now, keeps storage until the ack, never clears newer text", async () => {
    const kept = work("atonce");
    const h = mount(kept);
    act(() => h.result.current[1]("first"));
    const send = deferred();
    let done!: Promise<{ ok: boolean }>;
    act(() => {
      done = submitKept(handleOf(h.result.current), () => send.promise, {
        shows: "at-once",
      });
    });
    expect(h.result.current[0]).toBe("");
    expect(storedValue(kept)).toBe("first");

    // The user types the next message before the first one is acked.
    act(() => h.result.current[1]("second"));
    await act(async () => {
      send.resolve({ ok: true });
      await done;
    });
    expect(storedValue(kept)).toBe("second");
    expect(h.result.current[0]).toBe("second");
  });
});

function storageScopeOfPage() {
  return storageScopeOf(null);
}
