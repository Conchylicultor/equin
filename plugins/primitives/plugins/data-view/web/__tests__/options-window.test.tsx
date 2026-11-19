/**
 * A field whose options are an OPEN set (`optionsWindow`): the filter picker
 * reads one window of the collection itself — nothing while closed; open, the
 * top of the set (the scope alone); typed, the scope AND `contains` on the
 * search column — and says when more lie past the window. A pick outside the
 * window keeps its chip, never marked "not listed".
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const reads: unknown[] = [];
let answer: (where: unknown) => unknown = () => ({ status: "loading" });
vi.mock("@plugins/network/plugins/live/web", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useLive: (_c: unknown, query: { where: unknown }) => {
    reads.push(query.where);
    return answer(query.where);
  },
}));
vi.mock(
  "@plugins/primitives/plugins/log-channels/web",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    clientLog: () => {},
  }),
);

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { and, clause } from "@plugins/network/plugins/live/plugins/filter/core";
import { optionsWindow, type FieldDef } from "../../core";
import { ChipSelectFilterInput } from "../components/filter/chip-select-filter-input";

const pages = liveCollection("test.data-view.options-window", {
  fields: {
    site: textField({ label: "Site" }),
    path: textField({ label: "Page" }),
    visits: intField({ label: "Visits" }),
  },
  carry: { fields: { key: textField() } },
  id: "key",
  sortable: ["visits"],
  default: { orderBy: [["visits", "desc"]], limit: 2 },
  maxLimit: 10,
});

const PATHS = ["/", "/apps", "/apps/places", "/vision"];
const scope = clause("site", "eq", "s1");
const searchOf = (where: unknown): string => {
  if (JSON.stringify(where) === JSON.stringify(scope)) return "";
  const [, contains] = (where as { and: { operand: string }[] }).and;
  return contains!.operand;
};
answer = (where) => {
  const hits = PATHS.filter((p) => p.includes(searchOf(where)));
  return {
    status: "ready",
    data: hits
      .slice(0, 2)
      .map((path) => ({ key: path, site: "s1", path, visits: 1 })),
    canGrow: hits.length > 2,
    growing: false,
    loadMore: () => {},
    refetch: () => Promise.resolve(),
  };
};

const field: FieldDef<unknown> = {
  id: "pages",
  label: "Pages",
  type: "enum",
  optionsWindow: optionsWindow(pages, {
    where: scope,
    search: "path",
    option: (p) => ({ value: p.path, label: p.path }),
  }),
};

const open = () =>
  fireEvent.click(screen.getByRole("button", { name: "Select filter values" }));

afterEach(() => {
  cleanup();
  reads.length = 0;
});

describe("ChipSelectFilterInput over an options window", () => {
  it("reads nothing while closed; open, the top of the set and that more lie past it", () => {
    render(
      <ChipSelectFilterInput
        multiple
        value={["/vision"]}
        onChange={() => {}}
        field={field}
      />,
    );
    expect(reads).toEqual([]);
    open();
    expect(reads.at(-1)).toEqual(scope);
    expect(screen.getByText("/apps")).toBeTruthy();
    expect(screen.queryByText("/apps/places")).toBeNull();
    // A pick outside the window keeps its chip, never marked unlisted.
    expect(screen.getAllByText("/vision").length).toBeGreaterThan(0);
    expect(screen.queryByText(/not one of this field/)).toBeNull();
    expect(screen.getByText(/search to find others/)).toBeTruthy();
  });

  it("runs the typed search on the server: the scope AND contains on the search column", async () => {
    render(
      <ChipSelectFilterInput
        multiple
        value={undefined}
        onChange={() => {}}
        field={field}
      />,
    );
    open();
    fireEvent.change(screen.getByPlaceholderText("Search…"), {
      target: { value: "places" },
    });
    await waitFor(() =>
      expect(reads.at(-1)).toEqual(
        and(scope, clause("path", "contains", "places")),
      ),
    );
    expect(screen.getByText("/apps/places")).toBeTruthy();
    expect(screen.queryByText(/find others/)).toBeNull();
  });
});
