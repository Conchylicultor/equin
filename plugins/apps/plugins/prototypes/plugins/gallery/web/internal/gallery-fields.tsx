import type { FieldDef } from "@plugins/primitives/plugins/data-view/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import type { PrototypeMeta } from "@plugins/apps/plugins/prototypes/plugins/files/core";
import {
  NO_PROTOTYPE_STATE,
  type PrototypeState,
} from "@plugins/apps/plugins/prototypes/plugins/state/core";
import { tagFieldOptions } from "@plugins/tag-tree/plugins/engine/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import type { PrototypeGalleryRow } from "../slots";

const warningIcon = symbol("warning");
const scheduleIcon = symbol("schedule");
const historyIcon = symbol("history");
const deleteIcon = symbol("delete");

/** The prototypes' tag tree as the Tag field reads it (its options). */
export type TagFieldTree = Parameters<typeof tagFieldOptions>[0];

/**
 * The gallery's rows: the listed prototypes joined with their state (a
 * prototype with no row has `NO_PROTOTYPE_STATE`) and version count — once,
 * here, so every field, tone and card action reads the same values. A
 * prototype missing from the counts has no known count (`versions: undefined`
 * — its token is omitted, never drawn as v0).
 */
export function joinGalleryRows(
  prototypes: readonly PrototypeMeta[],
  states: readonly (PrototypeState & { readonly id: string })[],
  versionCounts: Record<string, number>,
): PrototypeGalleryRow[] {
  const byId = new Map<string, PrototypeState>(states.map((s) => [s.id, s]));
  return prototypes.map((p) => {
    const { done, pinned, tagId, deletedAt } =
      byId.get(p.name) ?? NO_PROTOTYPE_STATE;
    return {
      ...p,
      done,
      pinned,
      tagId,
      deletedAt,
      versions: versionCounts[p.name],
    };
  });
}

/**
 * Where the gallery pins its fields, over the record recipe's: the problems
 * count is a row-state mark on the title line, not a property (the problems
 * themselves are listed in the detail pane, where there is room to read them).
 */
export const GALLERY_PLACE = { problems: "afterTitle" } as const;

/**
 * The gallery's fields, over the prototypes' tag tree (the Tag field's
 * options). `title` is what the author named the prototype (its
 * `<title>`), so it is the display field; `name` is the minted id the URL and
 * the row key use — opaque, so it is searchable and never shown. A card reads
 * them as its three lines (the record recipe + `GALLERY_PLACE`): the title with
 * the problems mark after it, the blurb (prose) as the subtitle, then
 * when it was last edited and its version count as tokens.
 */
export function galleryFields(
  tags: TagFieldTree,
): FieldDef<PrototypeGalleryRow>[] {
  return [
    {
      id: "title",
      label: "Title",
      type: "text",
      primary: true,
      value: (p) => p.title,
    },
    {
      id: "blurb",
      label: "Blurb",
      type: "multiline-text",
      value: (p) => p.blurb,
    },
    {
      id: "name",
      label: "Folder",
      type: "identifier",
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
      value: (p) => (p.problems.length === 0 ? undefined : p.problems.length),
      cell: (p) => (
        <Badge variant="warning" icon={<Icon icon={warningIcon} />}>
          {p.problems.length}
        </Badge>
      ),
    },
    // "3d ago" / "v12" read the same as a card token and as a table cell (the
    // gallery mock's list draws its tokens' text in its columns), so neither
    // field needs a separate `token`. As columns (the soft "Recently edited"
    // table) both are narrow, end-aligned tracks — the mock's 72px / 64px —
    // and give way when the title runs out of room, the version count first.
    {
      id: "modifiedAt",
      label: "Edited",
      type: "date",
      icon: scheduleIcon,
      value: (p) => new Date(p.modifiedAt),
      cell: (p) => <RelativeTime date={new Date(p.modifiedAt)} />,
      width: "4.5rem",
    },
    // Absent when no count is known — the token is omitted, never "v0".
    {
      id: "versions",
      label: "Versions",
      type: "number",
      icon: historyIcon,
      value: (p) => p.versions,
      cell: (p) => (p.versions === undefined ? null : `v${p.versions}`),
      width: "4rem",
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
    // section headings (when grouped by it, in this options order) and as filter
    // values, where "Pinned" / "In progress" / "Done" say what "No" / "Yes"
    // cannot. A pin outranks Done: pinning a finished prototype is asking to
    // keep it in view. The values sort (by value, not options order) pinned >
    // in-progress > done: the default view sorts by it DESCENDING
    // (`prototypes.gallery.jsonc`) — keep that true on a rename.
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
    // The prototype's one tag. Its options are the tag tree (pre-order, each
    // with its parent and colour), so grouping by it NESTS — the gallery's
    // default grouping (`prototypes.gallery.jsonc`).
    {
      id: "tag",
      label: "Tag",
      type: "tag",
      options: tagFieldOptions(tags),
      value: (p) => p.tagId,
      visible: false,
    },
  ];
}

/**
 * The Trash's fields: the gallery's, plus when each prototype was deleted —
 * a token on the card, and what the Trash lists newest first.
 */
export function trashFields(
  tags: TagFieldTree,
): FieldDef<PrototypeGalleryRow>[] {
  return [
    ...galleryFields(tags),
    {
      id: "deletedAt",
      label: "Deleted",
      type: "date",
      icon: deleteIcon,
      value: (p) => p.deletedAt ?? undefined,
      cell: (p) =>
        p.deletedAt === null ? null : <RelativeTime date={p.deletedAt} />,
    },
  ];
}
