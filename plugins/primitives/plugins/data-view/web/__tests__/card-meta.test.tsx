import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import type { FieldDef } from "../../core";
import { DataViewSlots } from "../slots";
import { useResolveCell } from "../cell-slot";
import { useResolveCellEditor } from "../cell-editor-slot";
import { CardMeta } from "../components/card-meta";
import { partitionCardFields } from "../internal/card-fields";

/**
 * `CardMeta`: each line is its part (`data-part`), wears its theme-picked type
 * (the fallback rung = the look before the pick), and a token value is drawn
 * in the `token` context (`FieldDef.token` wins over its cell).
 */

type Row = { id: string; title: string; blurb: string; plays: number };

const ROW: Row = { id: "1", title: "Song", blurb: "About it", plays: 12 };

const FIELDS: FieldDef<Row>[] = [
  { id: "title", label: "Title", primary: true, value: (r) => r.title },
  { id: "blurb", label: "Blurb", value: (r) => r.blurb },
  {
    id: "plays",
    label: "Plays",
    type: "count",
    value: (r) => r.plays,
    cell: (r) => <span>cell:{r.plays}</span>,
    token: (r) => <span>{r.plays}×</span>,
  },
];

const plugin = {
  id: "data-view-card-meta-test",
  description: "card meta fixture",
  contributions: [],
  slots: DataViewSlots,
} as unknown as LoadedPlugin;

function Meta() {
  const resolveCell = useResolveCell();
  const resolveEditor = useResolveCellEditor();
  return (
    <CardMeta
      fields={partitionCardFields(FIELDS) as never}
      row={ROW}
      resolveCell={resolveCell}
      resolveEditor={resolveEditor}
    />
  );
}

function Harness() {
  return (
    <PluginProvider plugins={[plugin]}>
      <Meta />
    </PluginProvider>
  );
}

afterEach(cleanup);

describe("CardMeta", () => {
  it("stamps every line's part", () => {
    const { container } = render(<Harness />);
    const part = (p: string) => container.querySelector(`[data-part="${p}"]`);
    expect(part("dv.card-meta")).not.toBeNull();
    expect(part("dv.card-title")?.textContent).toBe("Song");
    expect(part("dv.card-subtitle")?.textContent).toBe("About it");
    expect(part("dv.card-tokens")).not.toBeNull();
    expect(
      container.querySelectorAll('[data-part="dv.card-token"]'),
    ).toHaveLength(1);
  });

  it("draws a token in the token context", () => {
    const { container } = render(<Harness />);
    const token = container.querySelector('[data-part="dv.card-token"]');
    expect(token?.textContent).toBe("12×");
  });

  it("keeps today's rungs as the picks' fallbacks", () => {
    const { container } = render(<Harness />);
    const part = (p: string) => container.querySelector(`[data-part="${p}"]`)!;
    expect(part("dv.card-title").classList).toContain("text-label");
    expect(part("dv.card-subtitle").classList).toContain("text-caption");
    // A numeric token picks the numeric part (fallback: the code role).
    expect(part("dv.card-token").querySelector(".text-code")).not.toBeNull();
  });
});
