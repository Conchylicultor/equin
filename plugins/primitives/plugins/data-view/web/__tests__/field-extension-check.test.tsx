/**
 * A field-extension contributor's fields are checked where they are declared:
 * inside the contributor's own `render(fields)`, so a bad declaration throws
 * during ITS render — caught by its own item boundary (the slot middleware the
 * error-boundary plugin registers; a stand-in here) — and the error names it.
 * The rest of the surface never renders on a schema that would lower wrong.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import { registerSlotItemMiddleware } from "@plugins/primitives/plugins/slot-render/web";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { liveCollection } from "@plugins/network/plugins/live/core";
import {
  type DataViewId,
  type FieldDef,
  type FieldExtensionProps,
  type FieldExtensionsDescriptor,
  type FilterOperatorSet,
  type LiveDataSource,
} from "../../core";
import { CollectFieldExtensions } from "../internal/field-extensions";
import { liveDataSource } from "../internal/live-data-source";
import { checkFieldColumns } from "../internal/live-fields";

class Boundary extends Component<
  { slotId: string; children: ReactNode },
  { error: Error | null }
> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override render() {
    return this.state.error ? (
      <div data-testid="contained">{this.state.error.message}</div>
    ) : (
      this.props.children
    );
  }
}
registerSlotItemMiddleware({
  priority: 100,
  Component: ({ slotId, children }) => (
    <Boundary slotId={slotId}>{children}</Boundary>
  ),
});

type Song = { id: string; title: string; fav: boolean };
const songs = liveCollection("test.data-view.field-extension-check", {
  fields: {
    title: textField({ label: "Title" }),
    fav: boolField({ label: "Favourite" }),
  },
  carry: { fields: { id: textField() } },
  id: "id",
  sortable: ["title"],
  default: { orderBy: [["title", "asc"]], limit: 2 },
  maxLimit: 6,
});
const source = liveDataSource(songs, { searchable: ["title"] });

const resolveOperatorSet = (type: string): FilterOperatorSet | undefined =>
  type === "bool"
    ? { match: "bool", domain: "boolean", operators: [] }
    : { match: "text", domain: "text", operators: [] };

function contributor(id: string, fields: FieldDef<unknown>[]) {
  const Fields = ({ render: emit }: FieldExtensionProps<unknown>) => (
    <>{emit(fields)}</>
  );
  return {
    _pluginId: "test.contributor-plugin",
    id,
    section: null,
    component: Fields,
  } as unknown as Contribution;
}

function descriptor(contributions: Contribution[]) {
  return {
    id: "test.field-extensions",
    useContributions: () => contributions,
  } as unknown as FieldExtensionsDescriptor<unknown>;
}

const validate = (fields: FieldDef<unknown>[], who: string) =>
  checkFieldColumns(
    fields,
    source as unknown as LiveDataSource<unknown>,
    resolveOperatorSet,
    `field extension "${who}"`,
  );

afterEach(cleanup);

describe("field-extension checks", () => {
  it("a contributor whose field does not resolve is contained by its own boundary, and named", () => {
    const good = contributor("good", [
      {
        id: "title",
        label: "Title",
        type: "text",
        value: (s) => (s as Song).title,
      },
    ]);
    // `fav` does not sort, but the field says it must.
    const bad = contributor("bad", [
      {
        id: "fav",
        label: "Favourite",
        type: "bool",
        value: (s) => (s as Song).fav,
        sortable: true,
      },
    ]);
    render(
      <CollectFieldExtensions
        sources={[descriptor([good, bad])]}
        base={[]}
        storageKey={"songs" as DataViewId}
        rowKey={(r) => (r as Song).id}
        liveColumnScope={null}
        validate={validate}
      >
        {(fields) => (
          <div data-testid="surface">{fields.map((f) => f.id).join(",")}</div>
        )}
      </CollectFieldExtensions>,
    );
    const contained = screen.getByTestId("contained");
    expect(contained.textContent).toMatch(
      /field extension "bad \(test\.contributor-plugin\)"/,
    );
    expect(contained.textContent).toMatch(/"fav" is marked sortable/);
    // The surface never rendered on the bad schema.
    expect(screen.queryByTestId("surface")).toBeNull();
  });

  it("valid contributions fold through", () => {
    const good = contributor("good", [
      {
        id: "title",
        label: "Title",
        type: "text",
        value: (s) => (s as Song).title,
      },
    ]);
    render(
      <CollectFieldExtensions
        sources={[descriptor([good])]}
        base={[]}
        storageKey={"songs" as DataViewId}
        rowKey={(r) => (r as Song).id}
        liveColumnScope={null}
        validate={validate}
      >
        {(fields) => (
          <div data-testid="surface">{fields.map((f) => f.id).join(",")}</div>
        )}
      </CollectFieldExtensions>,
    );
    expect(screen.getByTestId("surface").textContent).toBe("title");
  });
});
