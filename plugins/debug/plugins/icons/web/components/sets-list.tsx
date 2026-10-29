import { useMemo, type ReactElement } from "react";
import {
  DataView,
  defineDataView,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import type {
  ResourceReadiness,
  ResourceUnavailable,
} from "@plugins/primitives/plugins/live-state/core";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { CheckboxIndicator } from "@plugins/primitives/plugins/css/plugins/selection-indicator/web";
import type { IconFamilyId } from "@plugins/ui/plugins/icons/core";
import type { SetRow } from "../internal/model";

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
const ICON_SETS_VIEW = defineDataView("debug.icons.sets");

// The checkbox is no typed value, so it is pinned to the lead.
const SETS_PLACE = { shown: "lead" } as const;

const GROUP_OPTIONS = [
  { value: "app", label: "App sets" },
  { value: "library", label: "Libraries" },
];

/**
 * What a line says beyond its title: for an app set, its family and how far it
 * is from strict ("not strict yet · N still fall back to Lucide"); for a
 * library, the apps drawing in it. An app set with glyphs beyond the
 * manifest adds how many ("+12 own glyphs") — outside own/total, which count
 * the manifest's names only.
 */
export function describeSet(row: SetRow): string {
  const { family, counts } = row;
  if (row.group === "library") {
    return row.apps.length > 0 ? row.apps.join(", ") : "No app draws in it";
  }
  const owner =
    row.apps.length === 0 ? `${family.label} · no app picks it` : family.label;
  const extra = row.appOnly > 0 ? ` · +${row.appOnly} own glyphs` : "";
  if (family.coverage === "strict") {
    return counts.gap === 0
      ? `${owner} · strict${extra}`
      : `${owner} · strict · ${counts.gap} gaps${extra}`;
  }
  return `${owner} · not strict yet · ${counts.fallback} still fall back to ${family.fallbackLabel}${extra}`;
}

/**
 * The left list: every app set and library, each a column of the matrix —
 * a click shows or hides it.
 */
export function SetsList({
  rows,
  readiness,
  hidden,
  onToggle,
}: {
  rows: readonly SetRow[];
  readiness: ResourceReadiness | ResourceUnavailable;
  hidden: ReadonlySet<IconFamilyId>;
  onToggle: (family: IconFamilyId) => void;
}): ReactElement {
  const fields = useMemo<FieldDef<SetRow>[]>(
    () => [
      {
        id: "shown",
        label: "Shown",
        cell: (r) => <CheckboxIndicator checked={!hidden.has(r.family.id)} />,
      },
      {
        id: "title",
        label: "Set",
        type: "text",
        primary: true,
        value: (r) => r.title,
      },
      {
        id: "detail",
        label: "Coverage",
        type: "text",
        value: describeSet,
      },
      {
        id: "group",
        label: "Kind",
        type: "enum",
        value: (r) => r.group,
        options: GROUP_OPTIONS,
        groupable: true,
        visible: false,
      },
      {
        id: "own",
        label: "Own glyphs",
        type: "number",
        value: (r) => r.counts.own,
        cell: (r) => (
          <Badge mono>
            {r.counts.own}/{r.counts.total}
          </Badge>
        ),
      },
    ],
    [hidden],
  );
  return (
    <DataView<SetRow>
      rows={rows}
      fields={fields}
      rowKey={(r) => r.key}
      place={SETS_PLACE}
      views={["list"]}
      storageKey={ICON_SETS_VIEW}
      readiness={readiness}
      density="compact"
      title="Icon sets"
      rowActivation={(r) => () => onToggle(r.family.id)}
      viewOptions={{ list: { lines: 2 } }}
      emptyState={<>No icon set.</>}
    />
  );
}
