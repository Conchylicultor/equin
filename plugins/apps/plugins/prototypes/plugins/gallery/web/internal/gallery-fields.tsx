import type { FieldDef } from "@plugins/primitives/plugins/data-view/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import {
  statusOf,
  type PrototypeMeta,
  type PrototypeStatus,
} from "@plugins/apps/plugins/prototypes/plugins/files/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import type { PrototypeGalleryRow } from "../slots";

const warningIcon = symbol("warning");
const scheduleIcon = symbol("schedule");
const historyIcon = symbol("history");

/**
 * The gallery's rows: the listed prototypes joined with their status and
 * version count — once, here, so every field, tone and card action reads the
 * same values. A prototype missing from the counts has no known count
 * (`versions: undefined` — its token is omitted, never drawn as v0).
 */
export function joinGalleryRows(
  prototypes: readonly PrototypeMeta[],
  statuses: Record<string, PrototypeStatus>,
  versionCounts: Record<string, number>,
): PrototypeGalleryRow[] {
  return prototypes.map((p) => {
    const { done, pinned } = statusOf(statuses, p.name);
    return { ...p, done, pinned, versions: versionCounts[p.name] };
  });
}

/**
 * The gallery's fields. `title` is what the author named the prototype (its
 * `<title>`), so it is the display field; `name` is the minted id the URL and
 * the row key use — opaque, so it is searchable and never shown. A card reads
 * them as its three lines (`partitionCardFields`): the title with the problems
 * mark after it, the blurb (the one visible text field) as the subtitle, then
 * when it was last edited and its version count as tokens.
 */
export const galleryFields: FieldDef<PrototypeGalleryRow>[] = [
  {
    id: "title",
    label: "Title",
    type: "text",
    primary: true,
    value: (p) => p.title,
  },
  { id: "blurb", label: "Blurb", type: "text", value: (p) => p.blurb },
  {
    id: "name",
    label: "Folder",
    type: "text",
    value: (p) => p.name,
    visible: false,
  },
  // A row-state mark on the title line, not a property: the problems
  // themselves are listed in the detail pane, where there is room to read
  // them. Absent (not 0) for a prototype without any, so the mark is omitted.
  {
    id: "problems",
    label: "Problems",
    type: "number",
    indicator: true,
    value: (p) => (p.problems.length === 0 ? undefined : p.problems.length),
    cell: (p) => (
      <Badge variant="warning" icon={<Icon icon={warningIcon} />}>
        {p.problems.length}
      </Badge>
    ),
  },
  {
    id: "modifiedAt",
    label: "Edited",
    type: "date",
    icon: scheduleIcon,
    value: (p) => new Date(p.modifiedAt),
    cell: (p) => <RelativeTime date={new Date(p.modifiedAt)} />,
  },
  // Absent when no count is known — the token is omitted, never "v0".
  {
    id: "versions",
    label: "Versions",
    type: "number",
    icon: historyIcon,
    value: (p) => p.versions,
    cell: (p) => (p.versions === undefined ? null : `v${p.versions}`),
  },
  // Sort key: hidden on the card, offered in the sort and filter menus.
  {
    id: "createdAt",
    label: "Created",
    type: "date",
    value: (p) => new Date(p.createdAt),
    cell: (p) => <RelativeTime date={new Date(p.createdAt)} />,
    visible: false,
  },
  // Filter / group-by only — the card already shows it, as its pin and
  // Done circle. An enum rather than two bools, because this field is READ as
  // section headings (the gallery groups by it by default, in this options
  // order) and as filter values, where "Pinned" / "In progress" / "Done" say
  // what "No" / "Yes" cannot. A pin outranks Done: pinning a finished
  // prototype is asking to keep it in view.
  {
    id: "status",
    label: "Status",
    type: "enum",
    options: [
      { value: "pinned", label: "Pinned" },
      { value: "in-progress", label: "In progress" },
      { value: "done", label: "Done" },
    ],
    value: (p) => (p.pinned ? "pinned" : p.done ? "done" : "in-progress"),
    visible: false,
  },
];
