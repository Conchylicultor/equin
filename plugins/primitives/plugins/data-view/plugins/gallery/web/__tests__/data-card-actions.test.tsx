import { describe, it, expect, afterEach } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import {
  defineItemActions,
  type DataViewRenderProps,
  type FieldDef,
  type ItemActionProps,
} from "@plugins/primitives/plugins/data-view/web";
import { DataCard } from "../components/data-card";

/** One `defineItemActions` contribution (the factory's call argument). */
type ItemActionContribution<T> = Parameters<
  ReturnType<typeof defineItemActions<T>>
>[0];
import { GalleryView } from "../components/gallery-view";

// The first cases assert COMPOSITION only — that `DataCard` routes each action
// arm through the shared `RowActions` primitive (its reveal, its float chip)
// rather than re-implementing one — by reading the classes the primitive puts
// on the nodes it owns. They do not (and in jsdom cannot) prove the reveal
// happens on hover; that is the e2e's job.
//
// The rest are about the gallery VIEW: an action's declared zone and
// `useActive` decide which arm of the card it lands in.

/** Class selector for the outermost node of a hover-revealed cluster. */
const REVEALED = ".group-hover\\/row-actions\\:opacity-100";
/** A float chip (`RowActions chrome="float"`). */
const CHIP = ".bg-float-fill";

afterEach(cleanup);

describe("gallery DataCard", () => {
  it("draws the revealed arm on a hover-revealed float chip over the cover", () => {
    const { getByTestId } = render(
      <DataCard
        cover={null}
        actions={{ revealed: <button data-testid="action">act</button> }}
      >
        body
      </DataCard>,
    );
    const revealed = getByTestId("action").closest(REVEALED);
    expect(revealed).not.toBeNull();
    const cls = revealed!.className;
    // Hidden at rest is BOTH, never opacity alone.
    expect(cls).toContain("opacity-0");
    expect(cls).toContain("pointer-events-none");
    expect(cls).toContain("has-[:focus-visible]:opacity-100");
    expect(cls).not.toContain("group-focus-within");
    // On its own float chip.
    expect(getByTestId("action").closest(CHIP)).not.toBeNull();
  });

  it("anchors the reveal and the cover lift on the card itself", () => {
    const { container } = render(
      <DataCard cover={null} actions={{ revealed: <button>act</button> }}>
        body
      </DataCard>,
    );
    const card = container.firstElementChild!;
    expect(card.className).toContain("group/row-actions");
    expect(card.className).toContain("group/cover");
  });

  it("keeps the resting arm at the right edge, the revealed one to its left", () => {
    const { getByTestId } = render(
      <DataCard
        cover={null}
        actions={{
          atRest: <button data-testid="pin">pin</button>,
          revealed: <button data-testid="del">del</button>,
        }}
      >
        body
      </DataCard>,
    );
    const pin = getByTestId("pin");
    // At rest: always visible (no reveal classes), on a chip of its own.
    expect(pin.closest(REVEALED)).toBeNull();
    expect(pin.closest(CHIP)).not.toBeNull();
    // The hover chip mounts once the card is reached (the resting button is a
    // focus stop of its own, so it waits for the pointer).
    fireEvent.pointerOver(pin);
    // The revealed arm comes FIRST in the one pin, so the resting one keeps
    // the edge when hover adds it.
    const del = getByTestId("del");
    expect(
      del.compareDocumentPosition(pin) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(del.closest(".absolute")).toBe(pin.closest(".absolute"));
  });

  it("pins the primary arm bottom-right, apart from the cluster", () => {
    const { getByTestId } = render(
      <DataCard
        cover={null}
        actions={{
          revealed: <button data-testid="del">del</button>,
          primaryRevealed: <button data-testid="play">play</button>,
        }}
      >
        body
      </DataCard>,
    );
    const play = getByTestId("play");
    fireEvent.pointerOver(play);
    expect(play.closest(REVEALED)).not.toBeNull();
    // No chip: the primary action draws its own round button.
    expect(play.closest(CHIP)).toBeNull();
    expect(play.closest(".absolute")).not.toBe(
      getByTestId("del").closest(".absolute"),
    );
  });

  it("renders no action pin at all when there are no actions", () => {
    const { container } = render(<DataCard cover={null}>body</DataCard>);
    expect(container.querySelector(REVEALED)).toBeNull();
    expect(container.querySelector(CHIP)).toBeNull();
  });

  it("keeps data-row-key on the card root", () => {
    const { container } = render(
      <DataCard rowKey="r1" cover={null}>
        body
      </DataCard>,
    );
    expect(container.firstElementChild!.getAttribute("data-row-key")).toBe(
      "r1",
    );
  });
});

// --- The gallery view: which arm an action lands in ---

type Row = { id: string; name: string; on: boolean };

const fields: FieldDef<Row>[] = [
  { id: "name", label: "Name", type: "text", value: (r) => r.name },
];

const useOn = (row: Row): boolean => row.on;

function renderGallery(
  contributions: Omit<ItemActionContribution<Row>, "component">[],
  row: Row,
) {
  const Actions = defineItemActions<Row>();
  const plugin = {
    id: "gallery-zoned-actions-test",
    description: "gallery action-zone fixture",
    contributions: contributions.map((c) =>
      Actions({
        ...c,
        component: ({ placement }: ItemActionProps<Row>) => (
          <button data-testid={c.id} data-placement={placement}>
            {c.id}
          </button>
        ),
      }),
    ),
    slots: { actions: Actions },
  } as unknown as LoadedPlugin;
  const props: DataViewRenderProps<Row> = {
    revealSelection: true,
    rows: [row],
    fields,
    rowKey: (r) => r.id,
    state: { sort: [], query: "", filter: null },
    setSort: () => {},
    sortHeader: { active: [], sortable: new Set<string>() },
    setFilter: () => {},
    setExpanded: () => {},
    // Ungrouped: the clock is never consulted.
    now: 0,
    groupOrder: "asc",
    rowsComplete: true,
    sectioning: { kind: "bucket" },
    itemActions: Actions,
    options: undefined,
  };
  return render(
    <PluginProvider plugins={[plugin]}>
      <GalleryView {...(props as DataViewRenderProps<unknown>)} />
    </PluginProvider>,
  );
}

const OFF: Row = { id: "1", name: "alpha", on: false };
const ON: Row = { id: "1", name: "alpha", on: true };

describe("gallery view item-action zones", () => {
  it("a persistent action rests on the cover's chip; a revealed one is on hover", () => {
    const u = renderGallery(
      [{ id: "keep", zone: "persistent" }, { id: "delete" }],
      OFF,
    );
    expect(u.getByTestId("keep").closest(REVEALED)).toBeNull();
    expect(u.getByTestId("keep").closest(CHIP)).not.toBeNull();
    // The hover chip mounts once the card is reached.
    fireEvent.pointerOver(u.getByText("alpha"));
    expect(u.getByTestId("delete").closest(REVEALED)).not.toBeNull();
  });

  it("an active revealed action (pinned) rests; inactive it is on hover", () => {
    const off = renderGallery([{ id: "pin", useActive: useOn }], OFF);
    fireEvent.pointerOver(off.getByText("alpha"));
    expect(off.getByTestId("pin").closest(REVEALED)).not.toBeNull();
    cleanup();
    const on = renderGallery([{ id: "pin", useActive: useOn }], ON);
    expect(on.getByTestId("pin").closest(REVEALED)).toBeNull();
  });

  it("the primary action takes the cover's primary slot: on hover, at rest while active", () => {
    const off = renderGallery(
      [{ id: "play", zone: "primary", useActive: useOn }],
      OFF,
    );
    const play = off.getByTestId("play");
    expect(play.getAttribute("data-placement")).toBe("primary");
    expect(play.closest(REVEALED)).not.toBeNull();
    expect(play.closest(CHIP)).toBeNull();
    cleanup();
    const on = renderGallery(
      [{ id: "play", zone: "primary", useActive: useOn }],
      ON,
    );
    expect(on.getByTestId("play").closest(REVEALED)).toBeNull();
  });
});
