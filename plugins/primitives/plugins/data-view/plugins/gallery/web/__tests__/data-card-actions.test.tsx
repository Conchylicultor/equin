import { describe, it, expect, afterEach } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import {
  defineItemActions,
  type DataViewRenderProps,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import { DataCard } from "../components/data-card";
import { GalleryView } from "../components/gallery-view";

// The first three cases assert COMPOSITION only — that `DataCard` routes its
// `actions` through the shared `RowActions` primitive rather than
// re-implementing a reveal — by reading the classes the primitive puts on the
// node it owns. They do not (and in jsdom cannot) prove the reveal actually
// happens on hover; that is the e2e's job.
//
// The last two are about the gallery VIEW: every card is built by one
// construction site, so a custom body cannot drop a declared affordance, and an
// action's declared zone decides which cluster it lands in.

/** Class selector for the outermost node of a hover-revealed cluster. */
const REVEALED = ".group-hover\\/row-actions\\:opacity-100";

afterEach(cleanup);

describe("gallery DataCard actions", () => {
  it("renders actions through RowActions (coupled reveal on the cluster's own node)", () => {
    const { getByTestId } = render(
      <DataCard actions={<button data-testid="action">act</button>}>
        body
      </DataCard>,
    );

    // The reveal rides the OUTERMOST node the primitive renders — the masked
    // Pin — so walk up from the action, not down from the card.
    const revealed = getByTestId("action").closest(REVEALED);
    expect(revealed).not.toBeNull();

    const cls = revealed!.className;
    // Hidden at rest is BOTH, never opacity alone: an invisible cluster must not
    // stay a live click-target over the card body.
    expect(cls).toContain("opacity-0");
    expect(cls).toContain("pointer-events-none");
    // Hover is keyed on the primitive's private group, not a shared
    // hover-reveal group.
    expect(cls).toContain("group-hover/row-actions:opacity-100");
    expect(cls).toContain("group-hover/row-actions:pointer-events-auto");
    // Focus is asked about the CLUSTER's own subtree (`:has()` matches
    // descendants only) and only about keyboard focus, so tabbing to an action
    // reveals it while clicking anything in the card body does not.
    expect(cls).toContain("has-[:focus-visible]:opacity-100");
    expect(cls).toContain("has-[:focus-visible]:pointer-events-auto");
    // The regression this test now exists to catch: a row-scoped focus reveal
    // pinned the cluster open after any click inside the card.
    expect(cls).not.toContain("group-focus-within");
  });

  it("anchors the reveal on the card itself", () => {
    const { container } = render(
      <DataCard actions={<button>act</button>}>body</DataCard>,
    );

    const card = container.firstElementChild!;
    expect(card.className).toContain("group/row-actions");
  });

  it("renders no cluster at all when there are no actions", () => {
    const { container } = render(<DataCard>body</DataCard>);
    expect(container.querySelector(REVEALED)).toBeNull();
  });
});

// --- The gallery view: one card construction site, two action zones ---

type Row = { id: string; name: string };

const fields: FieldDef<Row>[] = [
  { id: "name", label: "Name", type: "text", value: (r) => r.name },
];

function renderProps(
  itemActions: DataViewRenderProps<Row>["itemActions"],
  options: DataViewRenderProps<Row>["options"],
): DataViewRenderProps<Row> {
  return {
    revealSelection: true,
    rows: [{ id: "1", name: "alpha" }],
    fields,
    rowKey: (r) => r.id,
    state: { sort: [], query: "", filter: null },
    setSort: () => {},
    sortHeader: { active: [], sortable: new Set<string>() },
    setFilter: () => {},
    setExpanded: () => {},
    // Grouping inputs. These fixtures render UNGROUPED, so the clock is never
    // consulted — a pinned zero states that rather than borrowing the real one.
    now: 0,
    groupOrder: "asc",
    rowsComplete: true,
    sectioning: { kind: "bucket" },
    itemActions,
    options,
  };
}

function renderGallery(
  plugins: LoadedPlugin[],
  props: DataViewRenderProps<Row>,
) {
  return render(
    <PluginProvider plugins={plugins}>
      <GalleryView {...(props as DataViewRenderProps<unknown>)} />
    </PluginProvider>,
  );
}

describe("gallery view item-action zones", () => {
  it("keeps the action cluster when the consumer supplies its own card body", () => {
    // The exact regression the old all-or-nothing `renderCard` caused: a
    // consumer that had ALREADY declared `itemActions` lost them by supplying an
    // unrelated option.
    const Actions = defineItemActions<Row>();
    const plugin = {
      id: "gallery-body-actions-test",
      description: "gallery custom-body fixture",
      contributions: [
        Actions({
          id: "act",
          component: () => <button data-testid="action">act</button>,
        }),
      ],
      slots: { actions: Actions },
    } as unknown as LoadedPlugin;

    const { getByTestId, getByText } = renderGallery(
      [plugin],
      renderProps(Actions, {
        renderBody: (r: Row): ReactNode => <div>custom {r.name}</div>,
      }),
    );

    getByText("custom alpha");
    expect(getByTestId("action").closest(REVEALED)).not.toBeNull();
  });

  it("paints a persistent action at rest in the card footer, revealed ones in the pinned cluster", () => {
    const Actions = defineItemActions<Row>();
    const plugin = {
      id: "gallery-zoned-actions-test",
      description: "gallery action-zone fixture",
      contributions: [
        Actions({
          id: "play",
          zone: "persistent",
          component: () => <button data-testid="play">play</button>,
        }),
        Actions({
          id: "delete",
          component: () => <button data-testid="delete">delete</button>,
        }),
      ],
      slots: { actions: Actions },
    } as unknown as LoadedPlugin;

    const { getByTestId } = renderGallery([plugin], renderProps(Actions, {}));

    // The persistent action lives in the card's in-flow footer cluster, which
    // is `alwaysVisible` — so it carries none of the reveal classes.
    expect(getByTestId("play").closest(REVEALED)).toBeNull();
    // It also sits in the card's flow (the footer), not in the pinned overlay
    // the revealed cluster uses.
    expect(getByTestId("play").closest(".absolute")).toBeNull();
    // The revealed one is in that pinned, hover-revealed cluster — mounted
    // once the card is reached (the footer's button gives the card a focus stop
    // of its own, so the cluster waits for the pointer or focus).
    fireEvent.pointerOver(getByTestId("play"));
    expect(getByTestId("delete").closest(REVEALED)).not.toBeNull();
  });
});
