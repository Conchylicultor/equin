import { useMemo, type ReactElement } from "react";
import {
  defineDataViewSources,
  type DataViewSourceProps,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import type { ResourceReadiness } from "@plugins/primitives/plugins/live-state/core";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import type {
  IconFamilyId,
  SymbolName,
  SymbolRef,
} from "@plugins/ui/plugins/icons/core";
import { IconCell, type IconSize } from "../components/icon-cell";
import {
  cellOf,
  fallsBack,
  matrixRows,
  statusOptions,
  tileGroupOptions,
  tileRows,
  type FamilyColumn,
  type MatrixRow,
  type ResolveSource,
  type TileRow,
} from "./model";

/** What the page threads to both sources of the Icons surface. */
export interface IconsHostProps {
  /** The manifest's names, and the read they come from (its loading / error state). */
  names: readonly SymbolName[];
  readiness: ResourceReadiness;
  /** The families shown, Material first. */
  columns: readonly FamilyColumn[];
  labelOf: (id: IconFamilyId) => string;
  resolve: ResolveSource;
  size: IconSize;
  fallbacksOnly: boolean;
  selected: string | undefined;
  onSelect: (key: string) => void;
}

/** The Matrix / By set sources of the one Icons DataView surface. */
export const IconsSources = defineDataViewSources<IconsHostProps>();

/**
 * A manifest name as an icon ref. The manifest IS the scan of the code's
 * `symbol("…")` literals, so each name was tsc-checked at its call site and
 * ships in the sprites — the reason `symbol()` wants a literal, satisfied.
 */
function refOf(name: SymbolName): SymbolRef {
  return { kind: "symbol", name };
}

const SOURCE_OPTIONS = [
  { value: "own", label: "Own" },
  { value: "fallback", label: "Falls back" },
  { value: "gap", label: "Gap" },
  { value: "glyph", label: "App-only glyph" },
  { value: "absent", label: "Not in this set" },
];

/** Matrix: one row per name (then per app-only glyph), one column per family shown. */
export function MatrixSource({
  hostProps,
  render,
}: DataViewSourceProps<IconsHostProps>): ReactElement {
  const {
    names,
    readiness,
    columns,
    labelOf,
    resolve,
    size,
    fallbacksOnly,
    selected,
    onSelect,
  } = hostProps;
  const rows = useMemo(() => {
    const all = matrixRows(names, columns, resolve);
    return fallbacksOnly ? all.filter(fallsBack) : all;
  }, [names, columns, resolve, fallbacksOnly]);
  const fields = useMemo<FieldDef<MatrixRow>[]>(
    () => [
      {
        id: "name",
        label: "Icon",
        type: "text",
        primary: true,
        value: (r) => r.name,
        cell: (r) => <Text variant="code">{r.name}</Text>,
        sortable: true,
      },
      {
        id: "status",
        label: "Coverage",
        type: "enum",
        value: (r) => r.status,
        options: statusOptions(columns),
        groupable: true,
        filterable: true,
        visible: false,
      },
      ...columns.map((column): FieldDef<MatrixRow> => ({
        id: `family:${column.id}`,
        label: column.label,
        type: "enum",
        value: (r) => cellOf(r, column.id).kind,
        options: SOURCE_OPTIONS,
        filterable: true,
        groupable: false,
        width: "6rem",
        align: "center",
        cell: (r) => {
          const source = cellOf(r, column.id);
          // An app-only glyph is not in the other sets: a blank cell, not a
          // fallback or a gap.
          if (source.kind === "absent") return null;
          return (
            <IconCell
              icon={r.kind === "glyph" ? r.icon : refOf(r.name)}
              family={column.id}
              source={source}
              labelOf={labelOf}
              size={size}
            />
          );
        },
      })),
    ],
    [columns, labelOf, size],
  );
  return (
    <>
      {render<MatrixRow>({
        rows,
        fields,
        rowKey: (r) => r.key,
        readiness,
        searchAccessor: (r) => r.name,
        selectedRowId: selected,
        rowActivation: (r) => () => onSelect(r.key),
        emptyState: <>No icon matches.</>,
      })}
    </>
  );
}

/** By set: one tile grid per family shown, its app-only glyphs in a group right after. */
export function BySetSource({
  hostProps,
  render,
}: DataViewSourceProps<IconsHostProps>): ReactElement {
  const {
    names,
    readiness,
    columns,
    labelOf,
    resolve,
    size,
    fallbacksOnly,
    selected,
    onSelect,
  } = hostProps;
  const rows = useMemo(
    () => tileRows(names, columns, resolve, fallbacksOnly),
    [names, columns, resolve, fallbacksOnly],
  );
  const fields = useMemo<FieldDef<TileRow>[]>(
    () => [
      {
        id: "glyph",
        label: "Glyph",
        leading: true,
        cell: (t) => (
          <IconCell
            icon={t.drawn.kind === "glyph" ? t.drawn.icon : refOf(t.drawn.name)}
            family={t.family}
            source={
              t.drawn.kind === "glyph" ? { kind: "glyph" } : t.drawn.source
            }
            labelOf={labelOf}
            size={size}
          />
        ),
      },
      {
        id: "name",
        label: "Icon",
        type: "text",
        primary: true,
        value: (t) => t.name,
        sortable: true,
      },
      {
        id: "family",
        label: "Set",
        type: "enum",
        value: (t) => t.group,
        options: tileGroupOptions(columns),
        groupable: true,
        filterable: true,
        visible: false,
      },
      {
        id: "source",
        label: "Drawn by",
        type: "enum",
        value: (t) =>
          t.drawn.kind === "glyph" ? "glyph" : t.drawn.source.kind,
        options: SOURCE_OPTIONS,
        filterable: true,
        visible: false,
      },
    ],
    [columns, labelOf, size],
  );
  return (
    <>
      {render<TileRow>({
        rows,
        fields,
        rowKey: (t) => t.key,
        readiness,
        searchAccessor: (t) => `${t.name} ${labelOf(t.family)}`,
        selectedRowId: selected,
        rowActivation: (t) => () => onSelect(t.key),
        emptyState: <>No icon matches.</>,
      })}
    </>
  );
}
