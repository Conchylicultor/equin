import { useMemo, useState, type ReactElement } from "react";

import { useCopyToClipboard } from "@plugins/primitives/plugins/copy-to-clipboard/web";
import { showToast } from "@plugins/shell/plugins/toast/web";
import {
  ControlPanel,
  ControlPanelPopover,
  type ControlPanelPopoverProps,
} from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { PAGE_BLOCK_TYPE, type Block } from "../../core";
import type { BlockEditorAPI } from "../types";
import { Editor, useBlockFrameMenus } from "../slots";
import { useBlockHandles } from "../internal/block-handles";
import { useBlockEditor } from "../block-editor-context";
import { useInsertableBlocks, BlockTypeList } from "./block-type-list";
import { blockEntries } from "../internal/block-sections";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const contentCopyIcon = symbol("content-copy");
const deleteIcon = symbol("delete");
const doNotDisturbOnIcon = symbol("do-not-disturb-on");
const unfoldLessIcon = symbol("unfold-less");
const unfoldMoreIcon = symbol("unfold-more");

/**
 * Per-block actions popover, opened from the gutter drag handle — the ONE rail
 * popover, dispatching on what the rail's seat OWNS.
 *
 * Two arms, and which one renders is decided by a CORE fact about the owner:
 *
 * - **an ordinary block** — a "Turn into" section listing insertable block types
 *   (→ `api.convertTo`) plus the `Editor.TurnInto` contributions that apply to
 *   it (no `from`, or `from` its type), then "Delete" (→ `api.remove`). Sub-page
 *   rows get only "Delete" — see `convertible`.
 * - **a void CONTAINER** (`BlockHandle.anchor`) — its contributed appearance
 *   sections, a "Turn into" section holding ONLY the `Editor.TurnInto`
 *   contributions declared `from` its type (none, no section), then the
 *   STRUCTURAL actions: Collapse/Expand, Remove `<label>`, Delete. No block-type
 *   list: a container owns no text, so a type conversion has nowhere to put its
 *   children. A target written for that container type knows where they go.
 *
 * The container arm is selected by `handle.anchor === true` and **not** by the
 * presence of a `menu` contribution: `context` contributes no sections (its
 * payload is `{}`) and must still get the structural actions. Ownership itself
 * is not resolved here — `RailSeat.owner` already did it, with the whole flatten
 * in view; this component only ever sees the block the rail acts on.
 *
 * On the ZOOM ROOT (`EditorScope.rootId`) the menu offers only what keeps the
 * root where it is: a plain type conversion keeps its id and its place, so it
 * stays, while Remove (which dissolves it), Delete (which removes the view),
 * a wrapping conversion (which reparents it) and the `TurnInto` transitions
 * (which re-partition its subtree) do not. The zoom's admission rule would
 * refuse them anyway; hiding them is what stops the menu offering clicks that
 * do nothing.
 */
export function BlockActionsMenu({
  trigger,
  block,
  api,
  childCount,
  align = "start",
  side = "bottom",
}: {
  trigger: ReactElement;
  block: Block;
  api: BlockEditorAPI;
  /**
   * How many children the block has in the FOREST, visible or folded away — the
   * seat owner's, threaded from `RailSeat.owner.childCount`. Only the container
   * arm reads it (a fold is worth offering from 2 children up), and it comes
   * from the seat rather than a lookup here because the rail's owner is not
   * necessarily the row that rendered it, so this component has no forest to ask.
   */
  childCount: number;
  align?: ControlPanelPopoverProps["align"];
  side?: ControlPanelPopoverProps["side"];
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const blocks = useInsertableBlocks();
  const { serverSync, unwrapBlock, scope } = useBlockEditor();
  const handle = useBlockHandles().get(block.type);
  const ContainerMenu = useBlockFrameMenus().get(block.type);
  const isContainer = handle?.anchor === true;
  const isScopeRoot = block.id === scope.rootId;
  // A `TurnInto` contribution converts a block into something the editor's own
  // pure `convertTo` cannot express — a server-backed transition (into a
  // sub-page, re-partitioning `page_id` across a page boundary). None of that
  // exists without rows, so the whole zone is gated on `serverSync` rather than
  // per-contributor, and it re-partitions the zoom root's subtree, so never
  // there.
  const turnIntoZone = serverSync && !isScopeRoot;
  // The targets written for THIS block's type — the container arm's whole
  // "Turn into", which renders only when there is one.
  const typedTurnInto = Editor.TurnInto.useContributions().some(
    (c) => c.from === block.type,
  );

  // Turn-into stays flat: it keeps its own "Turn into" eyebrow (below), so it
  // passes one label-less section and ignores the config's group boundaries
  // while still inheriting the flattened config order.
  const sections = useMemo(
    () =>
      blockEntries([
        {
          // A `wrapOnConvert` target mints a container and reparents the block
          // into it — for the zoom root, a move out of its own view.
          blocks: isScopeRoot ? blocks.filter((b) => !b.wrapOnConvert) : blocks,
        },
      ]),
    [blocks, isScopeRoot],
  );

  // A page row is not convertible. Converting it away from `page` would orphan
  // every row keyed `page_id = <this block's id>` — that subtree lives in
  // another partition and no query would ever reach it again. (The server
  // rejects the transition too; this hides the affordance that produces it.)
  const convertible = block.type !== PAGE_BLOCK_TYPE;

  // The container's name in the "Remove <name>" wording is DERIVED from the
  // handle's insert-menu label rather than passed in, so the action can never
  // describe a different container than the one it dissolves — and a new
  // container type needs no wiring here at all. A container with no `label` is
  // not offered in the palette either, so it has no user-facing name to use;
  // "container" is the honest generic, not a swallowed miss.
  const containerName = handle?.label?.toLowerCase() ?? "container";

  // Copying the id is the one action that applies to EVERY seat owner — an
  // ordinary block, a void container, and the page row alike — so it sits
  // outside both arms, beside Delete.
  const { copy: copyBlockId } = useCopyToClipboard(block.id);

  const close = () => setOpen(false);
  // Every row commits with `keepFocus` (on press, focus kept): the handle sits
  // beside a live caret, and a plain click would blur the block's editor (moving
  // the DOM selection) before the action runs.
  const commit = (run: () => void) => () => {
    run();
    close();
  };

  return (
    <ControlPanelPopover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setActiveIndex(-1);
      }}
      align={align}
      side={side}
      // Contributed sections host arbitrary controls — today a full icon picker
      // — so a menu carrying them takes the `picker` role (a panel whose body is
      // a grid); the structural actions and the turn-into list are a list of
      // choices, which is `menu`. There is no width prop to smuggle a
      // measurement through, and no `padding` either: the panel body owns its
      // own inset, and each zone below is a BAND, so the hairlines between them
      // are the container's rather than two hand-drawn `h-px` divs.
      size={ContainerMenu ? "picker" : "menu"}
      // The SAME comfort cap the `/` menu takes (`CaretTriggerMenu`'s
      // `maxHeight="lg"`) — the two render the same `BlockTypeList` and must
      // open the same size. Fitting the viewport is already unconditional; the
      // cap is what stops a full-height wall of block types under the cursor,
      // with the pointer travel and the covered content that implies.
      maxHeight="lg"
      label="Block actions"
      trigger={trigger}
    >
      {isContainer ? (
        <>
          {/* The container's own appearance, contributed by its plugin. The
              SAME component also renders in the glyph's popover: appearance is
              deliberately reachable from both, because the rail is where a
              user looks for block actions and the glyph is where they look for
              the glyph. It contributes its OWN bands, so a container with no
              appearance leaves no orphan rule behind. */}
          {ContainerMenu ? (
            // eslint-disable-next-line react-hooks/static-components -- not a component CREATED during render: `ContainerMenu` is a registry LOOKUP into the memoized `useBlockFrameMenus()` map, whose values are module-level slot contributions. Its identity is stable across renders, so no state can reset.
            <ContainerMenu block={block} api={api} close={close} />
          ) : null}
          {turnIntoZone && typedTurnInto ? (
            <ControlPanel.Section label="Turn into">
              <Editor.TurnInto.Render>
                {(a) =>
                  a.from === block.type ? (
                    <a.component block={block} api={api} close={close} />
                  ) : null
                }
              </Editor.TurnInto.Render>
            </ControlPanel.Section>
          ) : null}
          <ControlPanel.Section>
            {/* Collapse/Expand is the fold's FALLBACK. The primary affordance is
                the chevron on the container's borrowed line, which cannot always
                serve it: nested containers share one line so only the outermost
                claims a chevron, and a first child whose own chevron is
                load-bearing keeps it (`internal/rail-seat.ts`). With one child
                there is nothing to offer — the container's fold and its child's
                hide the same lines. */}
            {childCount > 1 && (
              <ControlPanel.Row
                keepFocus
                icon={
                  block.expanded ? (
                    <Icon icon={unfoldLessIcon} />
                  ) : (
                    <Icon icon={unfoldMoreIcon} />
                  )
                }
                onSelect={commit(() => api.setExpanded(!block.expanded))}
              >
                {block.expanded ? "Collapse" : "Expand"}
              </ControlPanel.Row>
            )}
            {/* Remove and Delete are DIFFERENT intents and must stay separate.
                Remove dissolves the box and promotes the children into its slot
                (the `unwrap` op — the escape hatch that keeps the content, and
                what Backspace at the start of the first child resolves to);
                Delete takes the subtree with it, exactly as any other block's
                Delete does. A single "delete the container" would conflate them. */}
            {!isScopeRoot && (
              <ControlPanel.Row
                keepFocus
                icon={<Icon icon={doNotDisturbOnIcon} />}
                onSelect={commit(() => unwrapBlock(block.id))}
              >
                {`Remove ${containerName}`}
              </ControlPanel.Row>
            )}
          </ControlPanel.Section>
        </>
      ) : convertible ? (
        <ControlPanel.Section label="Turn into">
          <BlockTypeList
            sections={sections}
            activeIndex={activeIndex}
            onHoverIndex={setActiveIndex}
            // `target`, not `handle`: the container arm above already binds
            // `handle` to the OWNER's handle, and a parameter shadowing it here
            // would read as the same value while being the conversion target.
            onSelect={({ block: target }) => {
              // Only the target's NON-text defaults: the block keeps its id,
              // hence its content doc, so `convertTo` carries its text over.
              api.convertTo(target.type, target.emptyRowData());
              close();
            }}
          />
          {/* The server-backed targets (`turnIntoZone`): the ones offered on
              every block, and the ones written for this block's type. */}
          {turnIntoZone ? (
            <Editor.TurnInto.Render>
              {(a) =>
                a.from === undefined || a.from === block.type ? (
                  <a.component block={block} api={api} close={close} />
                ) : null
              }
            </Editor.TurnInto.Render>
          ) : null}
        </ControlPanel.Section>
      ) : null}
      <ControlPanel.Section>
        {/* Contributed actions on the block (open-as-page, …), in both arms.
            Gated on `serverSync` like `TurnInto`: an in-memory block has no row
            anything outside this editor could act on. */}
        {serverSync ? (
          <Editor.BlockMenuItem.Render>
            {(item) => <item.component block={block} close={close} />}
          </Editor.BlockMenuItem.Render>
        ) : null}
        {/* The popover closes on commit, so the hook's own `copied` flash is
            never seen — the toast is the feedback. */}
        <ControlPanel.Row
          keepFocus
          icon={<Icon icon={contentCopyIcon} />}
          onSelect={commit(() => {
            copyBlockId();
            showToast({ description: "Block ID copied" });
          })}
        >
          Copy block ID
        </ControlPanel.Row>
        {!isScopeRoot && (
          <ControlPanel.Row
            keepFocus
            tone="danger"
            icon={<Icon icon={deleteIcon} />}
            onSelect={commit(() => api.remove())}
          >
            Delete
          </ControlPanel.Row>
        )}
      </ControlPanel.Section>
    </ControlPanelPopover>
  );
}
