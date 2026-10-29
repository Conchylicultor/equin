import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import {
  DataViewSlots,
  FieldCell,
  useIsChipField,
  useResolveCell,
  useResolveCellEditor,
  type DataViewRenderProps,
  type FieldDef,
  type TableCellProps,
} from "@plugins/primitives/plugins/data-view/web";
import { isFieldValueEmpty } from "@plugins/primitives/plugins/data-view/web/testing";
import { ListView } from "../components/list-view";

/**
 * The list's subtitle run moved to data-view's shared `SubtitleRun` (the soft
 * table's title cell draws it too). This pins that the list's subtitle markup
 * is byte-identical to the run as the list drew it before the extraction —
 * the reference below is that code, verbatim in behaviour.
 */

function ChipCell(props: TableCellProps) {
  return <Badge variant="muted">{String(props.value ?? "")}</Badge>;
}

const plugin = {
  id: "data-view-list-subtitle-extraction-test",
  description: "list subtitle extraction fixture",
  contributions: [
    DataViewSlots.Cell({ match: "chippy", component: ChipCell, chip: true }),
  ],
  slots: DataViewSlots,
} as unknown as LoadedPlugin;

type Row = {
  id: string;
  name: string;
  a: string;
  empty: string;
  kind: string;
  b: string;
};

const FIELDS: FieldDef<Row>[] = [
  {
    id: "name",
    label: "Name",
    type: "text",
    value: (r) => r.name,
    primary: true,
  },
  { id: "a", label: "A", type: "text", value: (r) => r.a },
  { id: "empty", label: "Empty", type: "text", value: (r) => r.empty },
  { id: "kind", label: "Kind", type: "chippy", value: (r) => r.kind },
  { id: "b", label: "B", type: "text", value: (r) => r.b },
];
// The view's type-erased schema, as the list holds it.
const ERASED = FIELDS as readonly FieldDef<unknown>[];
const SUBTITLE = ERASED.slice(1);

const ROW: Row = {
  id: "1",
  name: "alpha",
  a: "one",
  empty: "",
  kind: "webpage",
  b: "two",
};

/** The pre-extraction subtitle run (list-view.tsx `subtitleRun` +
 *  `SubtitleTerm` + `subtitleSeparator` + `drawnSubtitleTerms`). */
function LegacyRun({ titleSeam }: { titleSeam: boolean }): ReactNode {
  const resolveCell = useResolveCell();
  const resolveEditor = useResolveCellEditor();
  const isChipField = useIsChipField();
  const isChip = SUBTITLE.map((f) => isChipField(f));
  const titleIsChip = isChipField(ERASED[0]!);
  const terms: number[] = [];
  SUBTITLE.forEach((f, fi) => {
    if (!isFieldValueEmpty(f, ROW)) terms.push(fi);
  });
  return terms.map((fi, i) => {
    const prev = i > 0 ? terms[i - 1]! : titleSeam ? "title" : null;
    const sep =
      prev === null
        ? null
        : (prev === "title" ? titleIsChip : isChip[prev]!) || isChip[fi]
          ? " "
          : " · ";
    const field = SUBTITLE[fi]!;
    const cell = (
      <FieldCell
        field={field}
        row={ROW}
        resolveCell={resolveCell}
        resolveEditor={resolveEditor}
        display="inline"
      />
    );
    return (
      <span key={field.id}>
        {sep}
        {isChip[fi] ? (
          <Inline gap="none" className="max-w-full">
            {cell}
          </Inline>
        ) : (
          cell
        )}
      </span>
    );
  });
}

function listSubtitleHtml(options?: unknown): string {
  const props: DataViewRenderProps<Row> = {
    revealSelection: true,
    // Every non-title field is a subtitle term.
    placement: {
      place: { a: "line2", empty: "line2", kind: "line2", b: "line2" },
    },
    rows: [ROW],
    fields: FIELDS,
    rowKey: (r) => r.id,
    state: { sort: [], query: "", filter: null },
    setSort: () => {},
    sortHeader: { active: [], sortable: new Set<string>() },
    setFilter: () => {},
    setExpanded: () => {},
    now: 0,
    groupOrder: "asc",
    rowsComplete: true,
    sectioning: { kind: "bucket" },
    options,
  };
  const { container } = render(
    <PluginProvider plugins={[plugin]}>
      <ListView {...(props as DataViewRenderProps<unknown>)} />
    </PluginProvider>,
  );
  const subtitle = [...container.querySelectorAll(".text-muted-foreground")]
    // The deepest box holding the whole run: the subtitle leaf (a chip's own
    // muted badge holds only its value).
    .filter((el) =>
      ["one", "webpage", "two"].every((t) => el.textContent?.includes(t)),
    )
    .at(-1);
  if (!subtitle) throw new Error("no subtitle drawn");
  const html = subtitle.innerHTML;
  cleanup();
  return html;
}

function legacyHtml(titleSeam: boolean): string {
  const { container } = render(
    <PluginProvider plugins={[plugin]}>
      <div data-testid="ref">
        <LegacyRun titleSeam={titleSeam} />
      </div>
    </PluginProvider>,
  );
  const html = container.querySelector('[data-testid="ref"]')!.innerHTML;
  cleanup();
  return html;
}

afterEach(cleanup);

describe("data-view list subtitle after the SubtitleRun extraction", () => {
  it("draws the one-line run (title seam) exactly as before", () => {
    const html = listSubtitleHtml({ lines: 1 });
    expect(html).toBe(legacyHtml(true));
    expect(html).toContain(" · ");
  });

  it("draws the stacked run (no seam) exactly as before", () => {
    expect(listSubtitleHtml({ lines: 2 })).toBe(legacyHtml(false));
  });
});
