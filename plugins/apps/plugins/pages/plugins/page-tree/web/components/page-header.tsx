import type { Ref, RefObject } from "react";
import { ResourceView } from "@plugins/primitives/plugins/live-state/web";
import { mapRow, useLiveRow } from "@plugins/network/plugins/live/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { useEditableField } from "@plugins/primitives/plugins/editable-field/web";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import {
  pagesTree,
  pageData,
  updateBlock,
  type Block,
} from "@plugins/page/plugins/editor/core";
import type {
  BlockEditorHandle,
  CaretSurface,
} from "@plugins/page/plugins/editor/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  hoverRevealGroup,
  hoverRevealTarget,
} from "@plugins/primitives/plugins/hover-reveal/web";
import { RegenerateIconAction } from "@plugins/apps/plugins/pages/plugins/auto-icon/web";
import { PageIconButton } from "./page-icon-button";
import { PageTitle } from "./page-title";
import {
  PageDetail,
  type PageHeaderPart,
  type PageHeaderPartProps,
} from "../slots";
import { useSavePageData } from "../internal/use-save-page-data";
import "./page-header.css";

export function PageHeader({
  pageId,
  body,
  titleRef,
}: {
  pageId: string;
  /** The page body's caret surface, so the title can hand the caret down to it. */
  body?: RefObject<BlockEditorHandle | null>;
  /** The title's own caret surface, so the body can hand the caret back up. */
  titleRef?: Ref<CaretSurface>;
}) {
  // The page's own row; a page the set does not hold renders the header with
  // nothing to add to (`page` undefined).
  const result = mapRow(
    useLiveRow(pagesTree, pageId),
    (row): Block | undefined => row ?? undefined,
  );
  return (
    <ResourceView resource={result} fallback={<Loading variant="rows" />}>
      {(page) => (
        <PageHeaderInner
          pageId={pageId}
          page={page}
          body={body}
          titleRef={titleRef}
        />
      )}
    </ResourceView>
  );
}

function PageHeaderInner({
  pageId,
  page,
  body,
  titleRef,
}: {
  pageId: string;
  page: Block | undefined;
  body?: RefObject<BlockEditorHandle | null>;
  titleRef?: Ref<CaretSurface>;
}) {
  const data = page ? pageData(page) : undefined;
  const hasCover = data?.cover != null;
  const { mutateAsync } = useEndpointMutation(updateBlock);

  const title = useEditableField({
    value: data?.title ?? "",
    onSave: async (next) => {
      if (!page) return;
      await mutateAsync({
        params: { id: pageId },
        body: { data: { ...pageData(page), title: next } },
      });
    },
  });

  return (
    // `group/header` drives the hover-revealed tool row. The header owns no
    // horizontal geometry: the enclosing `PageContentColumn` already places it on
    // the block editor's content edge, so the title `<input>` below sits directly
    // on that edge with no padding of its own. When a cover is present the large
    // icon rises to overlap its bottom edge (a one-off visual overlap the spacing
    // ramp doesn't model — applied via inline negative margin, never a margin
    // utility).
    <Stack
      gap="xs"
      className={cn(hoverRevealGroup, "group/header", hasCover && "pt-lg")}
      style={hasCover ? undefined : HEADER_TOP_STYLE}
    >
      {page && data?.icon != null && (
        <HeaderIcon page={page} raised={hasCover} />
      )}

      {/* The hover row: every contributed header tool, each gated on what the
          page already has (Add icon / Change icon / Add cover). A page the list
          does not hold has nothing to add to. */}
      {page && (
        // See TOOLS_STYLE.
        <Stack
          direction="row"
          gap="xs"
          className={hoverRevealTarget}
          style={TOOLS_STYLE}
        >
          <PageDetail.HeaderTool.Render>
            {(part) => <HeaderPart part={part} entity={{ pageId, page }} />}
          </PageDetail.HeaderTool.Render>
        </Stack>
      )}

      <PageTitle field={title} body={body} ref={titleRef} />

      {page && (
        // The under-title band opens 10px under the title (this pad plus the
        // stack's gap) whether or not a part renders in it, so the rule below
        // keeps its distance from the title either way.
        <div style={UNDER_TITLE_STYLE}>
          <PageDetail.UnderTitle.Render>
            {(part) => <HeaderPart part={part} entity={{ pageId, page }} />}
          </PageDetail.UnderTitle.Render>
        </div>
      )}
    </Stack>
  );
}

/*
 * The header's vertical rhythm (the mockup's), each spelled as a sum of
 * density-ramp steps so it scales with the density preset:
 * - 56px above the icon on a page with no cover (with a cover, the icon
 *   rises onto it and the header keeps the `lg` step);
 * - the tool row hangs out by its own inline padding (a negative margin of
 *   the `xs` control pad), so each label — not its hover box — sits on the
 *   column's left edge with the title, and leaves 6px under itself (+ the
 *   stack's gap = 10px to the title);
 * - the under-title band starts 6px (+ the gap) under the title.
 */
const HEADER_TOP_STYLE = {
  paddingTop: "calc(var(--space-2xl) + var(--space-xl))",
};
const TOOLS_STYLE = {
  marginLeft: "calc(-1 * var(--control-pad-xs))",
  paddingBottom: "calc(var(--space-xs) + var(--space-2xs))",
};
const UNDER_TITLE_STYLE = {
  paddingTop: "calc(var(--space-xs) + var(--space-2xs))",
};

/** The large page icon over the title, opening the icon picker. */
function HeaderIcon({ page, raised }: { page: Block; raised: boolean }) {
  const save = useSavePageData(page);
  return (
    <PageIconButton
      value={{ icon: pageData(page).icon ?? null }}
      onChange={(next) => save({ icon: next.icon })}
      footerActions={() => <RegenerateIconAction pageId={page.id} />}
      className="relative z-raised"
      // The glyph's box hangs 4px out of the column (the `xs` step), so the
      // drawn glyph — not its hover box — lines up with the title.
      style={{
        marginLeft: "calc(-1 * var(--space-xs))",
        ...(raised ? { marginTop: "-3.5rem" } : {}),
      }}
    />
  );
}

/**
 * One header contribution, behind its `useAvailable` gate. The branch is on the
 * hook's PRESENCE (stable per contribution), so both leaves stay rules-of-hooks
 * clean — the same split `defineDetailSections` makes for `Section`.
 */
function HeaderPart({
  part,
  entity,
}: {
  part: PageHeaderPart;
  entity: PageHeaderPartProps;
}) {
  if (part.useAvailable) {
    return (
      <GatedHeaderPart
        useAvailable={part.useAvailable}
        Part={part.component}
        entity={entity}
      />
    );
  }
  const Part = part.component;
  return <Part {...entity} />;
}

function GatedHeaderPart({
  useAvailable,
  Part,
  entity,
}: {
  useAvailable: NonNullable<PageHeaderPart["useAvailable"]>;
  Part: PageHeaderPart["component"];
  entity: PageHeaderPartProps;
}) {
  return useAvailable(entity) ? <Part {...entity} /> : null;
}
