import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import type { ItemActionProps } from "../../core";
import {
  defineItemActions,
  type ItemActionContribution,
} from "../internal/define-item-actions";
import {
  useItemActionZones,
  type ItemActionArms,
} from "../internal/use-item-action-zones";

// The zone rule, end to end through a real `defineItemActions` set: which arm
// each action lands in for a row, per the view's slots. The arms are rendered
// side by side into labelled boxes, so a test reads "where did X go".

type Row = { id: string; on: boolean };

afterEach(cleanup);

function button(id: string) {
  return function Action({ placement }: ItemActionProps<Row>): ReactNode {
    return <button data-testid={id} data-placement={placement} />;
  };
}

/** `useActive` reading the row's own flag. */
const useOn = (row: Row): boolean => row.on;

function setup(
  contributions: Omit<ItemActionContribution<Row>, "component">[],
): {
  Actions: ReturnType<typeof defineItemActions<Row>>;
  plugin: LoadedPlugin;
} {
  const Actions = defineItemActions<Row>();
  const plugin = {
    id: "item-action-zones-test",
    description: "zone fixture",
    contributions: contributions.map((c) =>
      Actions({ ...c, component: button(c.id) }),
    ),
    slots: { actions: Actions },
  } as unknown as LoadedPlugin;
  return { Actions, plugin };
}

function Arms({
  name,
  arms,
  row,
}: {
  name: string;
  arms: ItemActionArms<Row> | null;
  row: Row;
}): ReactNode {
  if (arms === null) return <div data-testid={`${name}:none`} />;
  const target = { row, hasChildren: false };
  return (
    <>
      <div data-testid={`${name}:atRest`}>
        {arms.atRest ? arms.atRest(target) : "null"}
      </div>
      <div data-testid={`${name}:revealed`}>
        {arms.revealed ? arms.revealed(target) : "null"}
      </div>
    </>
  );
}

function mount(
  contributions: Omit<ItemActionContribution<Row>, "component">[],
  opts: { hasPersistentSlot: boolean; hasPrimarySlot: boolean },
  row: Row,
) {
  const { Actions, plugin } = setup(contributions);
  function View(): ReactNode {
    const zones = useItemActionZones(Actions, opts);
    return (
      <>
        <Arms name="cluster" arms={zones.cluster} row={row} />
        <Arms name="primary" arms={zones.primary} row={row} />
      </>
    );
  }
  return render(
    <PluginProvider plugins={[plugin]}>
      <View />
    </PluginProvider>,
  );
}

/** Where (arm box) action `id` landed, or `"nowhere"`. */
function whereIs(utils: ReturnType<typeof render>, id: string): string {
  const el = utils.queryByTestId(id);
  if (!el) return "nowhere";
  const box = el.closest(
    '[data-testid^="cluster:"], [data-testid^="primary:"]',
  );
  return box?.getAttribute("data-testid") ?? "unboxed";
}

const BOTH = { hasPersistentSlot: true, hasPrimarySlot: true };
const OFF: Row = { id: "1", on: false };
const ON: Row = { id: "1", on: true };

describe("useItemActionZones — the rest rule", () => {
  it("persistent rests; revealed is on hover", () => {
    const u = mount(
      [{ id: "keep", zone: "persistent" }, { id: "del" }],
      BOTH,
      OFF,
    );
    expect(whereIs(u, "keep")).toBe("cluster:atRest");
    expect(whereIs(u, "del")).toBe("cluster:revealed");
  });

  it("a revealed action with useActive rests only while active", () => {
    const off = mount([{ id: "pin", useActive: useOn }], BOTH, OFF);
    expect(whereIs(off, "pin")).toBe("cluster:revealed");
    cleanup();
    const on = mount([{ id: "pin", useActive: useOn }], BOTH, ON);
    expect(whereIs(on, "pin")).toBe("cluster:atRest");
  });

  it("a persistent action with useActive rests only while active", () => {
    const off = mount(
      [{ id: "done", zone: "persistent", useActive: useOn }],
      BOTH,
      OFF,
    );
    expect(whereIs(off, "done")).toBe("cluster:revealed");
    cleanup();
    const on = mount(
      [{ id: "done", zone: "persistent", useActive: useOn }],
      BOTH,
      ON,
    );
    expect(whereIs(on, "done")).toBe("cluster:atRest");
  });

  it("an arm nothing can land in is null", () => {
    const u = mount([{ id: "del" }], BOTH, OFF);
    expect(u.getByTestId("cluster:atRest").textContent).toBe("null");
    expect(u.getByTestId("primary:none")).toBeTruthy();
  });

  it("no persistent slot: every cluster action is on hover, whatever its rest state", () => {
    const u = mount(
      [
        { id: "keep", zone: "persistent" },
        { id: "pin", useActive: useOn },
        { id: "del" },
      ],
      { hasPersistentSlot: false, hasPrimarySlot: false },
      ON,
    );
    expect(whereIs(u, "keep")).toBe("cluster:revealed");
    expect(whereIs(u, "pin")).toBe("cluster:revealed");
    expect(whereIs(u, "del")).toBe("cluster:revealed");
    expect(u.getByTestId("cluster:atRest").textContent).toBe("null");
  });
});

describe("useItemActionZones — the primary action", () => {
  it("in a primary slot: revealed on hover, resting only while active, placement primary", () => {
    const off = mount(
      [{ id: "play", zone: "primary", useActive: useOn }, { id: "del" }],
      BOTH,
      OFF,
    );
    expect(whereIs(off, "play")).toBe("primary:revealed");
    expect(off.getByTestId("play").getAttribute("data-placement")).toBe(
      "primary",
    );
    expect(whereIs(off, "del")).toBe("cluster:revealed");
    cleanup();
    const on = mount(
      [{ id: "play", zone: "primary", useActive: useOn }],
      BOTH,
      ON,
    );
    expect(whereIs(on, "play")).toBe("primary:atRest");
  });

  it("without useActive it never rests in its slot", () => {
    const u = mount([{ id: "play", zone: "primary" }], BOTH, ON);
    expect(whereIs(u, "play")).toBe("primary:revealed");
    expect(u.getByTestId("primary:atRest").textContent).toBe("null");
  });

  it("no primary slot: demoted to persistent in the cluster (rests at rest)", () => {
    const u = mount(
      [{ id: "play", zone: "primary" }],
      { hasPersistentSlot: true, hasPrimarySlot: false },
      OFF,
    );
    expect(u.getByTestId("primary:none")).toBeTruthy();
    expect(whereIs(u, "play")).toBe("cluster:atRest");
    expect(u.getByTestId("play").getAttribute("data-placement")).toBe(
      "cluster",
    );
  });

  it("demoted with useActive: still always rests (the table keeps Play visible)", () => {
    const off = mount(
      [{ id: "play", zone: "primary", useActive: useOn }],
      { hasPersistentSlot: true, hasPrimarySlot: false },
      OFF,
    );
    expect(whereIs(off, "play")).toBe("cluster:atRest");
    expect(off.getByTestId("cluster:revealed").textContent).toBe("null");
    cleanup();
    const on = mount(
      [{ id: "play", zone: "primary", useActive: useOn }],
      { hasPersistentSlot: true, hasPrimarySlot: false },
      ON,
    );
    expect(whereIs(on, "play")).toBe("cluster:atRest");
  });

  it("throws on two primary actions", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      mount(
        [
          { id: "a", zone: "primary" },
          { id: "b", zone: "primary" },
        ],
        BOTH,
        OFF,
      ),
    ).toThrow(/at most one `zone: "primary"`/);
    spy.mockRestore();
  });
});
