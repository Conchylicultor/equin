import { useMemo } from "react";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import {
  mapResource,
  type ResourceResult,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { pagesTree, pageData, type Block } from "../../core";
import { PageIcon } from "./page-icon";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";

const addCircleIcon = symbol("add-circle");

/** One row in a page picker: an existing page, or a "create new page" affordance. */
export type PageOption =
  { kind: "page"; page: Block } | { kind: "create"; title: string };

/** The picker options read: the pages read's own states, mapped to options. */
export type PageOptionsResult = ResourceResult<PageOption[]>;

/** How many pages a picker lists at most: the closest matches, never the whole tree. */
const PICKER_LIMIT = 20;

/**
 * Ordered picker options for a query: the most recently edited pages whose
 * title contains it (case-insensitive, searched server-side — a window over
 * `pagesTree` filtered on its `title` column, at most {@link PICKER_LIMIT}),
 * followed by an optional "Create '<query>'" row when `allowCreate` and the
 * query is non-empty. Shared by the page-link block picker and the inline `[[`
 * typeahead so both surfaces stay identical.
 *
 * The pages read's own result, mapped: consumers render a distinct loading
 * state (instead of a premature "No pages found") and a failed read as a
 * failure. A new query is a new window; under the read's `resetKey` it keeps
 * the previous query's pages (`ready`) until its own land, so typing never
 * flashes the menu empty and Enter always commits a row.
 */
export function usePageOptions(
  query: string,
  opts?: { allowCreate?: boolean },
): PageOptionsResult {
  const q = query.trim();
  const resourceResult = useLive(
    pagesTree,
    {
      where: q === "" ? undefined : { title: { contains: q } },
      orderBy: [["editedAt", "desc"]],
      limit: PICKER_LIMIT,
    },
    { resetKey: "page-options" },
  );
  const allowCreate = opts?.allowCreate ?? false;
  return useMemo(
    () =>
      mapResource(resourceResult, (pages) => {
        const items: PageOption[] = pages.map((page) => ({
          kind: "page",
          page,
        }));
        if (allowCreate && q) {
          items.push({ kind: "create", title: q });
        }
        return items;
      }),
    [resourceResult, q, allowCreate],
  );
}

function PageOptionIcon({ page }: { page: Block }) {
  return (
    <Center as="span" className="size-4 text-muted-foreground">
      <PageIcon icon={pageData(page).icon} className="size-4" />
    </Center>
  );
}

/**
 * Presentational list of page-picker options with an active-row highlight.
 * Mirrors `BlockTypeList`, with the same two mutually-exclusive commit modes:
 *
 * - **`onCommit(index)`** — the `[[` caret menu. Rows commit on `onPointerDown`
 *   through `useCaretMenu`'s `commit` (pointerdown-timed + `editor.update`-
 *   wrapped), because a press on the focus-less surface perturbs the caret and
 *   unmounts the row before a `mousedown` could fire.
 * - **`onSelect(id)` / `onCreate(title)`** — the focused popover picker (the
 *   page-link block). Rows commit on `onMouseDown` + `preventDefault` so the
 *   click never blurs the picker's search field.
 */
export function PageOptionsList({
  options,
  activeIndex,
  onSelect,
  onCreate,
  onCommit,
  onHoverIndex,
}: {
  options: PageOption[];
  activeIndex: number;
  onSelect?: (pageId: string) => void;
  onCreate?: (title: string) => void;
  onCommit?: (index: number) => void;
  onHoverIndex?: (index: number) => void;
}) {
  if (options.length === 0) {
    return <Placeholder>No pages found</Placeholder>;
  }
  // Caret menu → commit on pointerdown; focused picker → commit on mousedown.
  const pressProps = (i: number, act: () => void) =>
    onCommit
      ? {
          onPointerDown: (e: React.PointerEvent) => {
            e.preventDefault();
            onCommit(i);
          },
        }
      : {
          onMouseDown: (e: React.MouseEvent) => {
            e.preventDefault();
            act();
          },
        };
  return (
    <Stack gap="none">
      {/* eslint-disable-next-line data-view/no-adhoc-row-list -- page-link typeahead menu (transient chrome) */}
      {options.map((option, i) =>
        option.kind === "page" ? (
          <Row
            key={option.page.id}
            selected={i === activeIndex}
            icon={<PageOptionIcon page={option.page} />}
            onMouseEnter={() => onHoverIndex?.(i)}
            {...pressProps(i, () => onSelect?.(option.page.id))}
          >
            <span className="truncate">
              {pageData(option.page).title || "Untitled"}
            </span>
          </Row>
        ) : (
          <Row
            key="__create__"
            selected={i === activeIndex}
            icon={
              <Icon icon={addCircleIcon} className="text-muted-foreground" />
            }
            onMouseEnter={() => onHoverIndex?.(i)}
            {...pressProps(i, () => onCreate?.(option.title))}
          >
            <span className="truncate">
              Create <span className="font-medium">“{option.title}”</span>
            </span>
          </Row>
        ),
      )}
    </Stack>
  );
}
