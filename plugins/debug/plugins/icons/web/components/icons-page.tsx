import { useMemo, useState, type ReactElement } from "react";
import {
  DataViewSwitcher,
  defineDataView,
} from "@plugins/primitives/plugins/data-view/web";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Rigid } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import {
  SegmentedControl,
  ToggleChip,
} from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import type { IconFamilyId, SymbolName } from "@plugins/ui/plugins/icons/core";
import {
  IconMotionRegion,
  resolveIconSource,
  useIconFamilies,
} from "@plugins/ui/plugins/icons/web";
import { iconManifest } from "@plugins/ui/plugins/icons/plugins/sprites/core";
import {
  familyColumns,
  familyCounts,
  familyLabels,
  setRows,
  type ResolveSource,
} from "../internal/model";
import { useAppFamilies } from "../internal/use-app-families";
import { IconsSources, type IconsHostProps } from "../internal/sources";
import { ICON_SIZES, type IconSize } from "./icon-cell";
import { SetsList } from "./sets-list";

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
const ICONS_VIEW = defineDataView("debug.icons");

const NO_NAMES: readonly SymbolName[] = [];

const SIZE_OPTIONS = ICON_SIZES.map((s) => ({ id: s, label: s }));

/**
 * Debug → Icons: every icon name the app draws (the build's manifest) as each
 * icon family draws it — Material and every contributed family, none named
 * here — with where each drawing comes from (own, a fallback, a strict gap),
 * and which apps draw in which family. The body is a motion region, so
 * hovering a row plays its animated glyphs.
 */
export function IconsPage(): ReactElement {
  const manifest = useLive(iconManifest);
  // The manifest is the scan of the code's `symbol("…")` literals: every name
  // was tsc-checked as a SymbolName at its call site.
  const names = foldResource(manifest, {
    loading: () => NO_NAMES,
    error: () => NO_NAMES,
    unavailable: () => NO_NAMES,
    ready: (m) => m.symbols as readonly SymbolName[],
  });
  const families = useIconFamilies();
  const apps = useAppFamilies();
  const columns = useMemo(() => familyColumns(families), [families]);
  const labelOf = useMemo(() => familyLabels(families), [families]);
  // `resolveIconSource` reads the family store; everything derived from it
  // also depends on `columns`, which is new with every family set.
  const resolve: ResolveSource = resolveIconSource;

  const [hidden, setHidden] = useState<ReadonlySet<IconFamilyId>>(new Set());
  const [size, setSize] = useState<IconSize>("20");
  const [fallbacksOnly, setFallbacksOnly] = useState(false);
  const [active, setActive] = useState(false);
  const [selected, setSelected] = useState<string>();

  const sets = useMemo(
    () =>
      setRows(columns, apps, (family) => familyCounts(names, family, resolve)),
    [columns, apps, names, resolve],
  );
  const shown = useMemo(
    () => columns.filter((c) => !hidden.has(c.id)),
    [columns, hidden],
  );
  const toggle = (family: IconFamilyId) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (!next.delete(family)) next.add(family);
      return next;
    });

  const hostBase: Omit<IconsHostProps, "readiness"> = {
    names,
    columns: shown,
    labelOf,
    resolve,
    size,
    active,
    fallbacksOnly,
    selected,
    onSelect: setSelected,
  };

  return (
    <Stack direction="row" gap="none" className="h-full" {...IconMotionRegion}>
      <Rigid className="w-72 border-r border-border">
        <SetsList
          rows={sets}
          readiness={manifest}
          hidden={hidden}
          onToggle={toggle}
        />
      </Rigid>
      <Fill>
        {manifest.status === "unavailable" ? (
          // A switcher source cannot carry the unavailable arm (data-view):
          // the page says it in the switcher's place.
          <Placeholder tone="muted">{manifest.message}</Placeholder>
        ) : (
          <DataViewSwitcher
            storageKey={ICONS_VIEW}
            sources={IconsSources}
            hostProps={{ ...hostBase, readiness: manifest }}
            defaultView="matrix"
            title="Icons"
            searchPlaceholder="Find an icon"
            actions={
              <Stack direction="row" gap="sm" align="center">
                <SegmentedControl
                  options={SIZE_OPTIONS}
                  value={size}
                  onChange={setSize}
                  label="Icon size"
                />
                <ToggleChip
                  active={active}
                  onClick={() => setActive((on) => !on)}
                >
                  Active
                </ToggleChip>
                <ToggleChip
                  active={fallbacksOnly}
                  onClick={() => setFallbacksOnly((on) => !on)}
                >
                  Fallbacks only
                </ToggleChip>
              </Stack>
            }
          />
        )}
      </Fill>
    </Stack>
  );
}
