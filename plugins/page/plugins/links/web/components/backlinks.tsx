import { useMemo, type ReactNode } from "react";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { clipClasses } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { ControlSizeProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import {
  DataView,
  defineDataView,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import type {
  HostedToolbar,
  HostedToolbarParts,
} from "@plugins/primitives/plugins/data-view/core";
import { PageIcon } from "@plugins/page/plugins/editor/web";
import {
  PageReferenceTrailing,
  usePageNavigation,
} from "@plugins/page/plugins/page-reference/web";
import { pageBacklinks } from "../../core";
import type { BacklinkRow, BacklinkSnippet } from "../../core";
import { symbol } from "@plugins/ui/plugins/icons/core";

const linkIcon = symbol("link");

export interface BacklinksProps {
  /** The target page whose backlinks (referencing pages) to show. */
  documentId: string;
}

const BACKLINKS_VIEW = defineDataView("page.links.backlinks");

/**
 * The list unfolds under the page title as plain rows (the mockup's in-place
 * list), so it draws no toolbar band: a handful of rows needs no view switcher,
 * search field or filter strip. The one options trigger (search, sort, filter)
 * still sits at the list's right edge, hover-revealed, so nothing is
 * unreachable. Module scope, so the frame's identity is stable.
 */
function BacklinksFrame({ options, body }: HostedToolbarParts): ReactNode {
  return (
    <Stack direction="row" gap="xs" align="start">
      <Fill>{body}</Fill>
      {options}
    </Stack>
  );
}

const BACKLINKS_TOOLBAR: HostedToolbar = {
  kind: "hosted",
  frame: BacklinksFrame,
};

/** Separator between the ancestor titles of a backlink's path. */
const PATH_SEPARATOR = " / ";

// Lists the pages that link to `documentId` as a DataView (search/sort come
// free). Subscribes to the `pageBacklinks` value so it updates live as edits
// reindex. Each row is two lines: the source page (icon, title, and its place
// in the page tree) and, under it, the excerpt of its first linking block with
// the link marked. Title-less on purpose: this is a body, and whatever hosts it
// owns the heading. No coupling to the pages app or any block type — navigation
// is whatever the surrounding host declared through `page-reference`, the same
// seam the reference blocks inside a page read.
export function Backlinks({ documentId }: BacklinksProps) {
  const nav = usePageNavigation();
  const result = useLive(pageBacklinks, { pageId: documentId });

  const fields = useMemo<FieldDef<BacklinkRow>[]>(
    () => [
      {
        id: "title",
        label: "Title",
        type: "text",
        value: (row) => row.title || "Untitled",
        primary: true,
      },
      {
        id: "path",
        label: "Location",
        type: "text",
        value: (row) => row.path.join(PATH_SEPARATOR),
      },
      {
        id: "snippet",
        label: "Excerpt",
        type: "text",
        value: (row) => (row.snippet === null ? "" : snippetText(row.snippet)),
      },
    ],
    [],
  );

  if (result.status === "loading") return null;
  if (result.status === "error") {
    return (
      <ResourceErrorInline
        error={result.error}
        refetch={result.refetch}
        variant="block"
        subject="the pages linking here"
      />
    );
  }
  const rows = result.data;
  if (rows.length === 0) return null;

  return (
    <DataView<BacklinkRow>
      rows={rows}
      fields={fields}
      rowKey={(row) => row.id}
      views={["list"]}
      storageKey={BACKLINKS_VIEW}
      toolbar={BACKLINKS_TOOLBAR}
      // A link, so ⌘/middle-click opens the source page in a browser tab. With
      // no declared navigation the rows are plain, inert entries.
      rowActivation={nav && ((row) => nav.open(row.id))}
      viewOptions={{
        list: {
          renderRow: (row: BacklinkRow) => <BacklinkBody row={row} />,
        },
      }}
    />
  );
}

/** The snippet as one string — what search matches against. */
function snippetText(s: BacklinkSnippet): string {
  return s.before + s.match + s.after;
}

/**
 * A backlink row's body: the title line (the source page's icon and title, then
 * its place in the tree, faint, pushed to the end and truncating from its lead
 * so the nearest parent stays readable) and — when the link sits inside text —
 * the excerpt around it, the link itself marked, indented under the title (the
 * icon's 16px plus the line's `sm` gap: the `xl` step). A block that IS the link
 * has no excerpt (`snippet: null`) and the row is its title line alone.
 *
 * The icon is part of the title line rather than the row's leading slot, so it
 * sits on the title rather than centred against both lines.
 *
 * Read at the comfortable type size: the list's body declares `xs` density for
 * its controls, which would drop every rung here by one; these are lines to
 * read, not a dense table, so the body declares `sm` back.
 */
function BacklinkBody({ row }: { row: BacklinkRow }) {
  return (
    <ControlSizeProvider size="sm">
      {/* Clipping floors this flex item's automatic minimum size at 0, so the
        lines inside can truncate against the row's width. */}
      <Stack gap="none" className={clipClasses({ axis: "both", fill: true })}>
        <Line className="gap-sm">
          <Center as="span" className="size-4 text-muted-foreground">
            <PageIcon icon={row.icon} fallback={linkIcon} className="size-4" />
          </Center>
          <Text variant="body" tone="strong" className="font-medium">
            {row.title || "Untitled"}
          </Text>
          <PageReferenceTrailing pageId={row.id} />
          {/* Pushes the place in the tree to the line's end. */}
          <Fill />
          {row.path.length > 0 && (
            <Text variant="caption" tone="faint" side="start">
              {row.path.join(PATH_SEPARATOR)}
            </Text>
          )}
        </Line>
        {row.snippet !== null && (
          <Line className="pl-xl">
            <Text variant="caption" tone="muted">
              {row.snippet.before}
              <mark className="bg-transparent font-medium text-foreground">
                {row.snippet.match}
              </mark>
              {row.snippet.after}
            </Text>
          </Line>
        )}
      </Stack>
    </ControlSizeProvider>
  );
}
