// The composite store's not-known-yet states (`composite-block-store.tsx`).
//
// A page's rows are `pending` until they land, and a pending feed has NO rows —
// not an empty list of them. Two claims:
//
// - the BASE page decides whether there is a document at all: while its feed is
//   pending the provider is not mounted (its hooks read the rows
//   unconditionally), and the editor's loading state renders in its place;
// - an expanded CHILD page still loading contributes no rows to the union and
//   names its anchor row in `loadingBelow`, so the editor renders a loading
//   region under it rather than an expansion that reads as an empty page — and
//   one whose first load FAILED names it in `failedBelow` instead, with the
//   failure and its retry.
//
// The per-page reads are faked at the `useServerBlockStore` seam, so each page's
// feed is settled exactly when the test says — the composite is the unit.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen } from "@testing-library/react";
import { renderWithTransport } from "@plugins/primitives/plugins/networking/web/testing";
import { useEffect } from "react";
import { PluginProvider } from "@plugins/framework/plugins/web-sdk/core";
import { UndoRedoProvider } from "@plugins/primitives/plugins/undo-redo/web";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import {
  PAGE_BLOCK_TYPE,
  planForestInsert,
  withMintedIds,
  type Block,
  type SerializedBlock,
} from "../../core";
import { fromNodes } from "../internal/optimistic-block-ops";
import { useBlockEditor } from "../block-editor-context";
import { CompositeServerProviderHost } from "../composite-block-store";
import {
  NOTHING_FAILED,
  NOTHING_LOADING,
  type BlockStore,
} from "../block-store";

const feeds = vi.hoisted(() => {
  const stores = new Map<string, unknown>();
  const listeners = new Set<() => void>();
  return {
    stores,
    subscribe(cb: () => void) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    publish(pageId: string, store: unknown) {
      stores.set(pageId, store);
      for (const cb of listeners) cb();
    },
  };
});

vi.mock("../block-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../block-store")>();
  const { useSyncExternalStore } = await import("react");
  return {
    ...actual,
    // One page's feed: pending until the test publishes a settled store for it.
    useServerBlockStore: (pageId: string) =>
      useSyncExternalStore(
        feeds.subscribe,
        () =>
          (feeds.stores.get(pageId) as BlockStore | undefined) ??
          actual.PENDING_BLOCK_STORE,
      ),
  };
});

const BASE = "base-page";

let uuidCounter = 0;
Object.defineProperty(globalThis.crypto, "randomUUID", {
  value: () => `id-${++uuidCounter}`,
  configurable: true,
  writable: true,
});

beforeEach(() => {
  uuidCounter = 0;
  feeds.stores.clear();
});
afterEach(cleanup);

function text(t: string): SerializedBlock {
  return {
    type: "page/text",
    data: { text: [{ text: t }] },
    expanded: true,
    children: [],
  };
}

/**
 * The base page: one text line and an EXPANDED sub-page holding one line of
 * its own. Split by owning page, exactly as the two feeds would serve them.
 */
function seed(): { baseRows: Block[]; subId: string; subRows: Block[] } {
  const forest: SerializedBlock[] = [
    text("A"),
    {
      type: PAGE_BLOCK_TYPE,
      data: { title: "Sub" },
      expanded: true,
      children: [text("C1")],
    },
  ];
  const { nodes } = planForestInsert({
    pageId: BASE,
    parentId: BASE,
    rootRanks: Rank.nBetween(null, null, forest.length),
    forest: withMintedIds(forest),
  });
  const rows = fromNodes(nodes, []);
  const sub = rows.find((r) => r.type === PAGE_BLOCK_TYPE);
  if (!sub) throw new Error("seed has no sub-page row");
  return {
    baseRows: rows.filter((r) => r.pageId === BASE),
    subId: sub.id,
    subRows: rows.filter((r) => r.pageId === sub.id),
  };
}

function settled(rows: Block[]): BlockStore {
  return {
    pending: false,
    data: rows,
    serverData: rows,
    loadingBelow: NOTHING_LOADING,
    failedBelow: NOTHING_FAILED,
    dispatch: vi.fn(),
  };
}

type Ctx = ReturnType<typeof useBlockEditor>;

function Probe({ onCtx }: { onCtx: (ctx: Ctx) => void }) {
  const ctx = useBlockEditor();
  useEffect(() => {
    onCtx(ctx);
  });
  return null;
}

function mount(): { ctx: () => Ctx | null } {
  const sink: { ctx: Ctx | null } = { ctx: null };
  renderWithTransport(
    <PluginProvider plugins={[]}>
      <UndoRedoProvider>
        <CompositeServerProviderHost pageId={BASE} rootId={null}>
          <Probe
            onCtx={(next) => {
              sink.ctx = next;
            }}
          />
        </CompositeServerProviderHost>
      </UndoRedoProvider>
    </PluginProvider>,
  );
  return { ctx: () => sink.ctx };
}

const ids = (blocks: readonly Block[]) => blocks.map((b) => b.id).sort();

describe("composite store while a feed is pending", () => {
  it("renders the loading state, not the provider, until the base page's rows land", () => {
    const { baseRows } = seed();
    const h = mount();
    expect(h.ctx()).toBeNull();
    expect(screen.queryAllByRole("status")).not.toHaveLength(0);

    act(() => feeds.publish(BASE, settled(baseRows)));

    const ctx = h.ctx();
    expect(ctx).not.toBeNull();
    expect(ids(ctx!.blocks)).toEqual(ids(baseRows));
  });

  it("a still-loading child page adds no rows and marks its anchor as loading", () => {
    const { baseRows, subId, subRows } = seed();
    const h = mount();
    act(() => feeds.publish(BASE, settled(baseRows)));

    // The expanded sub-page mounted a feed of its own, still pending: its row
    // is there, its content is not, and the editor is told it is coming.
    expect(ids(h.ctx()!.blocks)).toEqual(ids(baseRows));
    expect([...h.ctx()!.loadingBelow]).toEqual([subId]);

    act(() => feeds.publish(subId, settled(subRows)));

    expect(ids(h.ctx()!.blocks)).toEqual(ids([...baseRows, ...subRows]));
    expect(h.ctx()!.loadingBelow.size).toBe(0);
  });

  it("a child page whose first load failed is not loading: its anchor carries the failure and its retry", () => {
    const { baseRows, subId, subRows } = seed();
    const h = mount();
    act(() => feeds.publish(BASE, settled(baseRows)));

    const error = new Error("boom");
    const refetch = vi.fn(() => Promise.resolve());
    act(() => feeds.publish(subId, { pending: true, error, refetch }));

    // No rows from the failed page, no loading region — the failure instead.
    expect(ids(h.ctx()!.blocks)).toEqual(ids(baseRows));
    expect(h.ctx()!.loadingBelow.size).toBe(0);
    expect([...h.ctx()!.failedBelow]).toEqual([[subId, { error, refetch }]]);

    // The retry lands the rows: the failure clears.
    act(() => feeds.publish(subId, settled(subRows)));
    expect(ids(h.ctx()!.blocks)).toEqual(ids([...baseRows, ...subRows]));
    expect(h.ctx()!.failedBelow.size).toBe(0);
  });

  it("feeds already settled at mount compose into one document with nothing loading", () => {
    const { baseRows, subId, subRows } = seed();
    feeds.publish(BASE, settled(baseRows));
    feeds.publish(subId, settled(subRows));
    const h = mount();
    expect(ids(h.ctx()!.blocks)).toEqual(ids([...baseRows, ...subRows]));
    expect(h.ctx()!.loadingBelow.size).toBe(0);
  });
});
