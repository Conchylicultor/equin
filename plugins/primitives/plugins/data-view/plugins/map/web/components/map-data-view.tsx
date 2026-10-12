import { useMemo, type ReactNode } from "react";
import { resolveTypeChain } from "@plugins/fields/core";
import { MapView } from "@plugins/map/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { runActivation } from "@plugins/primitives/plugins/link-gesture/core";
import {
  pickPrimaryField,
  useFieldIdentities,
  useFlatRows,
  useResolveOperatorSet,
  type DataViewRenderProps,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import type { MapViewOptions } from "../../core";
import {
  DEFAULT_ROW_PIN_TYPE,
  pickLocationField,
  rowsToPins,
} from "../internal/row-pins";

/** The per-instance options the view reads off the config row. */
interface MapInstanceOptions {
  locationField?: string;
}

/** The default pin name: the primary field's value, when it has one. */
function primaryLabel<TRow>(
  field: FieldDef<TRow> | undefined,
): (row: TRow) => string | undefined {
  return (row) => {
    const value = field?.value?.(row);
    return value === null || value === undefined ? undefined : String(value);
  };
}

/**
 * Map view: every row (after search → filter → sort) holding a valid location
 * is one pin on a full-bleed map, clustered by default. Clicking a pin
 * activates its row — the same per-row activation the other views wire to a
 * click — and the selected row's pin renders active and is panned into view.
 *
 * `rows`/`fields`/`options` arrive type-erased as `unknown`; this is the
 * documented re-cast boundary for the view child.
 */
export function MapDataView(props: DataViewRenderProps<unknown>): ReactNode {
  const resolveOperatorSet = useResolveOperatorSet();
  const identities = useFieldIdentities();
  const rows = useFlatRows(
    props.rows,
    props.fields,
    props.state,
    resolveOperatorSet,
    props.searchAccessor,
  );
  // Code options (`viewOptions.map`) and the instance's config-row options
  // arrive merged in one opaque bag.
  const options = (props.options ?? {}) as MapViewOptions<unknown> &
    MapInstanceOptions;

  const pick = pickLocationField(props.fields, options.locationField, (t) =>
    resolveTypeChain(t, identities),
  );
  const locationField = pick.kind === "found" ? pick.field : undefined;
  const labelField = pickPrimaryField(
    props.fields.filter((f) => f !== locationField),
  );
  const label = useMemo(
    () => options.label ?? primaryLabel(labelField),
    [options.label, labelField],
  );

  const mapped = useMemo(
    () =>
      locationField
        ? rowsToPins({
            rows,
            rowKey: props.rowKey,
            locationField,
            pinType: options.pinType ?? DEFAULT_ROW_PIN_TYPE,
            pinData: options.pinData,
            label,
          })
        : null,
    [
      rows,
      props.rowKey,
      locationField,
      options.pinType,
      options.pinData,
      label,
    ],
  );

  if (pick.kind === "missing-configured") {
    return (
      <Center className="size-full">
        <Placeholder tone="error">
          {`This map view reads locations from the field "${pick.id}", which this list does not have.`}
        </Placeholder>
      </Center>
    );
  }
  if (mapped === null) {
    return (
      <Center className="size-full">
        <Placeholder tone="error">
          This list has no location field to put on a map.
        </Placeholder>
      </Center>
    );
  }

  const { pins, rowById, missing } = mapped;
  const onActivate = (id: string) => {
    const row = rowById.get(id);
    if (row === undefined) return;
    const activation = props.rowActivation?.(row);
    if (activation !== undefined) runActivation(activation);
    else props.onRowOpen?.(row);
  };
  const selected = props.selectedRowId ?? null;
  const cluster =
    options.cluster === false ? undefined : (options.cluster ?? {});

  return (
    <div className="relative size-full">
      <MapView
        overlays={pins}
        cluster={cluster}
        activeId={selected}
        focusId={selected}
        fitPadding={options.fitPadding}
        onActivate={onActivate}
        empty={
          props.emptyState ?? (
            <Placeholder>
              {rows.length === 0
                ? "Nothing to show on the map."
                : "None of these have a location yet."}
            </Placeholder>
          )
        }
      />
      {pins.length > 0 && missing > 0 ? (
        <Pin to="bottom-left" offset="md" layer="raised">
          <Badge variant="muted">{`${missing} without location`}</Badge>
        </Pin>
      ) : null}
    </div>
  );
}
