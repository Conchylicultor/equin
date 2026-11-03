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
import {
  PluginProvider,
  type Contribution,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { SlotRender } from "@plugins/primitives/plugins/slot-render/web";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { liveCollection } from "@plugins/network/plugins/live/core";
import type { ResourceResult } from "@plugins/network/plugins/live/plugins/live-state/web";
import {
  type DataViewId,
  type FieldDef,
  type FieldValue,
  type FilterOperatorSet,
  type LiveDataSource,
} from "../../core";
import type {
  ExtensionField,
  FieldExtensionProps,
  FieldExtensionsDescriptor,
} from "../internal/field-extension-types";
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
// The error-boundary middleware's stand-in, contributed as the browser does.
const boundaryPlugin = {
  id: "test.boundary",
  description: "boundary",
  contributions: [
    SlotRender.ItemMiddleware({
      depth: 100,
      Component: ({ slotId, children }) => (
        <Boundary slotId={slotId}>{children}</Boundary>
      ),
    }),
  ],
  slots: SlotRender,
} as unknown as LoadedPlugin;

function renderWithBoundary(ui: ReactNode) {
  return render(
    <PluginProvider plugins={[boundaryPlugin]}>{ui}</PluginProvider>,
  );
}

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
const source = liveDataSource(songs, {
  searchable: ["title"],
  surface: "songs" as DataViewId,
  unscoped: { reason: "a test surface" },
});

const resolveOperatorSet = (type: string): FilterOperatorSet | undefined =>
  type === "bool"
    ? { match: "bool", domain: "boolean", operators: [] }
    : { match: "text", domain: "text", operators: [] };

type Readers = Readonly<Record<string, (row: unknown) => FieldValue>>;

/** A contributor handing `fields` back: their `value`s as its readers, read as `values` (default: ready). */
function contributor(
  id: string,
  fields: FieldDef<unknown>[],
  values?: ResourceResult<Readers>,
) {
  const declared = fields.map(
    ({ value: _value, ...rest }) => rest as ExtensionField<unknown>,
  );
  const readers: Readers = Object.fromEntries(
    fields.map((f) => [f.id, f.value ?? (() => undefined)]),
  );
  const read: ResourceResult<Readers> = values ?? {
    status: "ready",
    data: readers,
    refetch: async () => {},
  };
  const Fields = ({ render: emit }: FieldExtensionProps<unknown>) => (
    <>{emit({ fields: declared, values: read })}</>
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
    renderWithBoundary(
      <CollectFieldExtensions
        sources={[descriptor([good, bad])]}
        base={[]}
        storageKey={"songs" as DataViewId}
        rowKey={(r) => (r as Song).id}
        liveColumns={{ kind: "in-memory" }}
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
    renderWithBoundary(
      <CollectFieldExtensions
        sources={[descriptor([good])]}
        base={[]}
        storageKey={"songs" as DataViewId}
        rowKey={(r) => (r as Song).id}
        liveColumns={{ kind: "in-memory" }}
        validate={validate}
      >
        {(fields) => (
          <div data-testid="surface">{fields.map((f) => f.id).join(",")}</div>
        )}
      </CollectFieldExtensions>,
    );
    expect(screen.getByTestId("surface").textContent).toBe("title");
  });

  it("while the values read loads, every contributed field is pending — never the decode of an unknown value", () => {
    const loading = contributor(
      "loading",
      [{ id: "title", label: "Title", type: "text" }],
      { status: "loading", refetch: async () => {} },
    );
    renderWithBoundary(
      <CollectFieldExtensions
        sources={[descriptor([loading])]}
        base={[]}
        storageKey={"songs" as DataViewId}
        rowKey={(r) => (r as Song).id}
        liveColumns={{ kind: "in-memory" }}
        validate={validate}
      >
        {(fields) => (
          <div data-testid="surface">
            {fields.map((f) => `${f.id}:${String(f.pending)}`).join(",")}
          </div>
        )}
      </CollectFieldExtensions>,
    );
    // Kept (a view's rule on it does not dangle), and pending.
    expect(screen.getByTestId("surface").textContent).toBe("title:true");
  });

  it("a reader for a field the contributor does not declare is refused, inside its own boundary", () => {
    const stray = contributor("stray", [], {
      status: "ready",
      data: { ghost: () => 1 },
      refetch: async () => {},
    });
    renderWithBoundary(
      <CollectFieldExtensions
        sources={[descriptor([stray])]}
        base={[]}
        storageKey={"songs" as DataViewId}
        rowKey={(r) => (r as Song).id}
        liveColumns={{ kind: "in-memory" }}
        validate={validate}
      >
        {() => <div data-testid="surface" />}
      </CollectFieldExtensions>,
    );
    expect(screen.getByTestId("contained").textContent).toMatch(
      /"ghost", which it declares no field for/,
    );
    expect(screen.queryByTestId("surface")).toBeNull();
  });

  it("a contributed field cannot author its value or its read state (tsc)", () => {
    const field: ExtensionField<unknown> = {
      id: "x",
      label: "X",
      // @ts-expect-error — the host stamps `value` from the values read.
      value: () => 1,
    };
    const pending: ExtensionField<unknown> = {
      id: "y",
      label: "Y",
      // @ts-expect-error — `pending` is the read's state, never authored.
      pending: false,
    };
    expect([field.id, pending.id]).toEqual(["x", "y"]);
  });
});
