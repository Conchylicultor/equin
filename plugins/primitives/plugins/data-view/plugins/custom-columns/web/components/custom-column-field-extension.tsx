import { useMemo, type ReactNode } from "react";
import type { ConfigDescriptor } from "@plugins/config_v2/core";
import type { FieldsRecord } from "@plugins/fields/core";
import { resolveTypeChain } from "@plugins/fields/core";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import { mapResource } from "@plugins/primitives/plugins/live-state/web";
import {
  getDataViewDescriptor,
  type ExtensionField,
  type FieldExtensionProps,
  useResolveValueCodec,
  useResolveOperatorSet,
  useResolveColumnDerive,
  useFieldIdentities,
} from "@plugins/primitives/plugins/data-view/web";
import type {
  DataViewId,
  FieldValue,
} from "@plugins/primitives/plugins/data-view/core";
import { scopedLiveColumns } from "@plugins/network/plugins/live/core";
import { CUSTOM_COLUMNS_SET } from "../../core";
import { useCustomColumnDefs } from "../internal/use-custom-column-defs";
import {
  useCustomColumnValues,
  useSetCustomColumnValue,
} from "../internal/use-custom-column-values";

/**
 * Global field-extension contribution: composes the per-surface custom-column
 * DEFINITIONS (config) with the per-row VALUES (live resource) into ordinary
 * `FieldDef[]` and hands them back through `render`, so the data-view host folds
 * them into the schema — custom columns then flow through every view +
 * sort/filter/search for free.
 *
 * This inverts the old host-owned `useCustomColumnFields` bridge: custom-columns
 * now imports data-view's `FieldDef`/`DataViewId` + `getDataViewDescriptor` (a
 * legal child→parent edge) rather than the host importing custom-columns' hooks.
 */
export function CustomColumnFieldExtension({
  storageKey,
  rowKey,
  liveColumns,
  render,
}: FieldExtensionProps<unknown>): ReactNode {
  const descriptor = getDataViewDescriptor(storageKey);
  // Soft-disable for a storageKey with no registered viewsDescriptor — preserves
  // the old host's `descriptor != null` gate. `storageKey` is stable per surface,
  // so this branch is hook-order-stable (the `Inner` hooks never conditionally
  // appear/disappear within one surface).
  if (!descriptor) return <>{render(null)}</>;
  return (
    <Inner
      descriptor={descriptor}
      storageKey={storageKey}
      rowKey={rowKey}
      liveColumns={liveColumns}
      render={render}
    />
  );
}

/**
 * The bridge body (formerly the host's `useCustomColumnFields`): read defs +
 * values, map each `CustomColumnDef` → an `ExtensionField`, and hand the fields
 * with their values as ONE read through `render` — the host stamps `value` and
 * the read's state (`pending` while the values load, the failure with Retry),
 * so a cell never reads as unset while its value is not known yet.
 *
 * `rowKey` is captured via `useLatestRef` to decouple from the consumer's inline
 * arrow identity (re-created every render), so the produced fields stay
 * referentially stable across renders. The bridge calls `rowKey(row, 0)` —
 * `FieldDef.value`/`onEdit` get no index, so a surface with index-derived row keys
 * cannot key custom-column values (a documented edge case).
 */
function Inner({
  descriptor,
  storageKey,
  rowKey,
  liveColumns,
  render,
}: {
  descriptor: ConfigDescriptor<FieldsRecord>;
  storageKey: DataViewId;
  rowKey: (row: unknown, index: number) => string;
  liveColumns: FieldExtensionProps<unknown>["liveColumns"];
  render: FieldExtensionProps<unknown>["render"];
}): ReactNode {
  const { defs } = useCustomColumnDefs(descriptor, storageKey);
  const values = useCustomColumnValues(storageKey);
  const setValue = useSetCustomColumnValue();
  const rowKeyRef = useLatestRef(rowKey);
  const resolveCodec = useResolveValueCodec();
  const resolveOps = useResolveOperatorSet();
  const deriveFromConfig = useResolveColumnDerive();
  const identities = useFieldIdentities();

  const fields = useMemo(() => {
    // Capability-derived flags — NO type-name literals. A type is filterable
    // when it resolves a non-empty filter operator set (in that set's domain);
    // sortable when some type in its `extends` chain declares a `coerce` (the
    // sortable scalar projection). Hardcoding `true` would show an empty filter
    // UI for types (e.g. avatar) with no filter operators / no coerce.
    const capabilities = new Map(
      defs.map((def) => {
        const ops = resolveOps(def.type);
        return [
          def.id,
          {
            domain:
              ops !== undefined && ops.operators.length > 0 ? ops.domain : null,
            sortable: resolveTypeChain(def.type, identities).some(
              (id) => identities.get(id)?.coerce != null,
            ),
          },
        ] as const;
      }),
    );
    // Under a live source whose collection takes this surface's scoped
    // columns, each column sorts and filters server-side as a member of the
    // `custom` set (`custom.<id>`), declared as the definitions stand now; the
    // server decodes it against ITS definitions.
    // Under one that cannot take them (`unscoped`, with its stated reason),
    // they show and edit, and neither sort nor filter — the rows are the
    // server's, and the server has no column for them.
    const scoped =
      liveColumns.kind !== "scoped"
        ? null
        : scopedLiveColumns(
            liveColumns.scope,
            CUSTOM_COLUMNS_SET,
            Object.fromEntries(
              [...capabilities].filter(
                ([, c]) => c.domain !== null || c.sortable,
              ),
            ),
          );
    return defs.map((def): ExtensionField<unknown> => {
      const codec = resolveCodec(def.type);
      const capability = capabilities.get(def.id)!;
      const serverless = liveColumns.kind === "unscoped";
      const sortable = !serverless && capability.sortable;
      const filterable = !serverless && capability.domain !== null;
      return {
        // The type's own projection of its opaque config onto GENERIC FieldDef
        // keys (enum's `config.options` → `options`), so downstream consumers
        // read one contract and never crack open `config` themselves. Spread
        // FIRST: a derivation contributes vocabulary, never identity/storage.
        ...deriveFromConfig(def.type, def.config),
        id: def.id,
        label: def.label,
        // NOT a literal — the field-type registry is the extension seam; the
        // type is dispatched through the generic cell/editor/filter slots.
        type: def.type,
        onEdit: (row, next) =>
          setValue({
            dataViewId: storageKey,
            rowKey: rowKeyRef.current(row, 0),
            columnId: def.id,
            value: codec.encode(next),
          }),
        // Opaque per-type config (e.g. enum options); understood only by the
        // field type's own code, passed through untouched.
        config: def.config,
        sortable,
        filterable,
        ...(scoped !== null && (filterable || sortable)
          ? { column: scoped.column(def.id) }
          : {}),
      };
    });
  }, [
    defs,
    setValue,
    storageKey,
    rowKeyRef,
    resolveCodec,
    resolveOps,
    deriveFromConfig,
    identities,
    liveColumns,
  ]);

  // Each column's value per row, as the ONE values read: while it loads every
  // column is pending (kept, so a view's filter rule on one is not left
  // dangling), a failure over held values keeps painting them.
  const read = useMemo(
    () =>
      mapResource(values, (index) =>
        Object.fromEntries(
          defs.map((def) => {
            // Native↔text codec round-trips the typed cell value through the
            // generic `TEXT` storage column; string types (text/enum) resolve
            // IDENTITY_CODEC.
            const codec = resolveCodec(def.type);
            return [
              def.id,
              (row: unknown): FieldValue =>
                codec.decode(index.get(rowKeyRef.current(row, 0))?.get(def.id)),
            ];
          }),
        ),
      ),
    [values, defs, resolveCodec, rowKeyRef],
  );

  return <>{render({ fields, values: read })}</>;
}
