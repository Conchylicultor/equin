/**
 * The pages Trash dialog's wiring, over a stubbed DataView (how a live list
 * draws, pages and searches is the primitive's tested behaviour):
 *
 * - nothing is read until the dialog opens; open, it mounts ONE DataView over
 *   the live `trashEntries` source scoped to the pages source, searchable by
 *   label, with the trash row actions;
 * - the field schema resolves against that source as the DataView resolves it
 *   at mount (`deletedAt` sorts on the server, the scope column is never
 *   offered as a filter), and an empty label draws as "Untitled";
 * - Restore restores the row's entry straight away; Delete permanently opens
 *   the confirmation, and only confirming purges.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  FieldDef,
  FilterOperatorSet,
  fieldOverrides,
} from "@plugins/primitives/plugins/data-view/web";
import type { LiveDataSource } from "@plugins/primitives/plugins/data-view/core";
import {
  deriveFields,
  resolveLiveFields,
} from "@plugins/primitives/plugins/data-view/web/testing";
import { filterColumns } from "@plugins/network/plugins/live/plugins/filter/core";
import {
  trashEntries,
  type TrashEntryRow,
} from "@plugins/infra/plugins/trash/core";
import { PAGES_TRASH_SOURCE } from "@plugins/page/plugins/editor/core";
import { PagesTrash } from "../components/pages-trash";
import {
  PurgeTrashEntryAction,
  RestoreTrashEntryAction,
  TrashItemActions,
} from "../components/trash-item-actions";
import plugin from "../index";

/** The overrides the dialog hands its DataView. */
type TrashOverrides = ReturnType<typeof fieldOverrides<typeof trashEntries>>;

/** What the stubbed seams hold. */
const stub = vi.hoisted(() => ({
  /** The props the stubbed DataView last rendered with. */
  props: undefined as Record<string, unknown> | undefined,
  /** How many times the stubbed DataView rendered. */
  renders: 0,
  /** The rows the stubbed DataView draws (the live read, as loaded). */
  rows: [] as unknown[],
  /** Every endpoint mutation's `mutate` calls, by route. */
  mutations: new Map<string, unknown[][]>(),
}));

// The DataView stub draws each row the way a list does: its primary cell and
// the row's actions — the real action components, so their context and
// mutations run through the dialog's own tree.
vi.mock(
  "@plugins/primitives/plugins/data-view/web",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    DataView: (props: Record<string, unknown>) => {
      stub.props = props;
      stub.renders++;
      const overrides = props.overrides as TrashOverrides;
      const label = overrides.byId.label!;
      return (
        <ul>
          {(stub.rows as TrashEntryRow[]).map((entry) => (
            <li key={entry.id} data-testid={`row-${entry.id}`}>
              <span>{label.cell!(entry)}</span>
              <RestoreTrashEntryAction
                row={entry}
                hasChildren={false}
                placement="cluster"
              />
              <PurgeTrashEntryAction
                row={entry}
                hasChildren={false}
                placement="cluster"
              />
            </li>
          ))}
        </ul>
      );
    },
  }),
);

vi.mock("@plugins/infra/plugins/endpoints/web", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useEndpointMutation: (endpoint: { route: string }) => ({
    isPending: false,
    mutate: (...args: unknown[]) => {
      const calls = stub.mutations.get(endpoint.route) ?? [];
      calls.push(args);
      stub.mutations.set(endpoint.route, calls);
      // The purge's caller closes its confirmation on success.
      const opts = args[1] as { onSuccess?: () => void } | undefined;
      opts?.onSuccess?.();
    },
  }),
}));

vi.mock(
  "@plugins/apps/plugins/pages/plugins/shell/web",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    PagesSidebarRow: ({
      label,
      onClick,
    }: {
      label: string;
      onClick: () => void;
    }): ReactNode => <button onClick={onClick}>{label}</button>,
  }),
);

const RESTORE = "POST /api/trash/:sourceId/:entryId/restore";
const PURGE = "POST /api/trash/:sourceId/:entryId/purge";

const entry = (id: string, label: string): TrashEntryRow => ({
  id: id as TrashEntryRow["id"],
  sourceId: PAGES_TRASH_SOURCE,
  rootEntityId: `blk-${id}`,
  label,
  deletedAt: new Date("2026-10-01T12:00:00Z"),
  meta: {},
  $columns: {},
});

beforeEach(() => {
  stub.props = undefined;
  stub.renders = 0;
  stub.rows = [entry("trash-1", "Groceries"), entry("trash-2", "")];
  stub.mutations = new Map();
});

afterEach(() => {
  cleanup();
});

function openTrash() {
  render(<PagesTrash />);
  fireEvent.click(screen.getByRole("button", { name: "Trash" }));
}

describe("<PagesTrash>", () => {
  it("reads nothing until the dialog opens", () => {
    render(<PagesTrash />);
    expect(stub.renders).toBe(0);
  });

  it("lists the pages trash as a live list DataView with the trash row actions", () => {
    openTrash();
    const props = stub.props!;
    expect(props.views).toEqual(["list"]);
    expect(props.density).toBe("compact");
    expect(props.itemActions).toBe(TrashItemActions);
    expect(props.emptyState).toBe("Trash is empty");
    const source = props.source as LiveDataSource<TrashEntryRow>;
    expect(source.collection.key).toBe(trashEntries.key);
    expect(source.searchable).toEqual(["label"]);
    expect(source.scope.kind).toBe("where");
    if (source.scope.kind !== "where") return;
    expect([...filterColumns(source.scope.filter)]).toEqual(["sourceId"]);
    expect(JSON.stringify(source.scope.filter)).toContain(
      JSON.stringify(PAGES_TRASH_SOURCE),
    );

    expect(screen.getByTestId("row-trash-1").textContent).toContain(
      "Groceries",
    );
    expect(screen.getByTestId("row-trash-2").textContent).toContain("Untitled");
  });

  it("restores a row's entry straight away", () => {
    openTrash();
    const row = screen.getByTestId("row-trash-1");
    fireEvent.click(row.querySelector('[aria-label="Restore"]')!);
    expect(stub.mutations.get(RESTORE)).toEqual([
      [{ params: { sourceId: PAGES_TRASH_SOURCE, entryId: "trash-1" } }],
    ]);
    expect(stub.mutations.get(PURGE)).toBeUndefined();
  });

  it("purges only once the confirmation is accepted", () => {
    openTrash();
    const row = screen.getByTestId("row-trash-1");
    fireEvent.click(row.querySelector('[aria-label="Delete permanently"]')!);
    expect(stub.mutations.get(PURGE)).toBeUndefined();
    const confirm = screen.getByRole("dialog", { name: "Delete permanently" });
    expect(confirm.textContent).toContain("Groceries");
    const buttons = confirm.querySelectorAll("button");
    const accept = [...buttons].find(
      (b) => b.textContent === "Delete permanently",
    )!;
    fireEvent.click(accept);
    expect(stub.mutations.get(PURGE)).toEqual([
      [
        { params: { sourceId: PAGES_TRASH_SOURCE, entryId: "trash-1" } },
        expect.objectContaining({ onSuccess: expect.any(Function) }),
      ],
    ]);
    expect(stub.mutations.get(RESTORE)).toBeUndefined();
  });
});

describe("the trash row actions", () => {
  it("are contributed to the list's item-actions slot, painted at rest", () => {
    const actions = plugin.contributions
      .filter((c) => c._slot === TrashItemActions)
      .map((c) => ({ id: c.id, zone: c.zone }));
    expect(actions).toEqual([
      { id: "restore", zone: "persistent" },
      { id: "purge", zone: "persistent" },
    ]);
  });

  it("refuse to render outside the dialog's list (no purge handler)", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      render(
        <PurgeTrashEntryAction
          row={entry("trash-1", "Groceries")}
          hasChildren={false}
          placement="cluster"
        />,
      ),
    ).toThrow(/outside the pages Trash dialog/);
  });
});

/** Operator sets reduced to what field resolution reads: each type's domain. */
const DOMAINS: Record<string, FilterOperatorSet["domain"]> = {
  text: "text",
  date: "instant",
};
const resolveOperatorSet = (type: string): FilterOperatorSet | undefined =>
  DOMAINS[type] === undefined
    ? undefined
    : { match: type, domain: DOMAINS[type]!, operators: [] };

describe("the field schema over the trash source", () => {
  it("resolves at mount: deletedAt sorts on the server, the scope is not a filter", () => {
    openTrash();
    const source = stub.props!.source as LiveDataSource<TrashEntryRow>;
    const overrides = stub.props!.overrides as TrashOverrides;
    // The list's schema: the derived fields with its overrides applied.
    const fields = deriveFields(trashEntries, true, []).fields.map(
      (f): FieldDef<TrashEntryRow> =>
        ({ ...f, ...overrides.byId[f.id] }) as FieldDef<TrashEntryRow>,
    );
    const plan = resolveLiveFields<TrashEntryRow>(
      fields,
      source,
      resolveOperatorSet,
      "pages.trash",
    );
    expect(plan.sortFields.map((f) => f.id)).toEqual(["deletedAt"]);
    expect(plan.columnOf.get("label")).toBe("label");
    expect(plan.filterFields.map((f) => f.id)).not.toContain("sourceId");
  });
});
