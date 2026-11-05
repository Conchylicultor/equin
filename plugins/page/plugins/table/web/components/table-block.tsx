import { useRef, useState } from "react";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import {
  Text,
  textVariantClass,
} from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  hoverRevealGroup,
  hoverRevealTarget,
} from "@plugins/primitives/plugins/hover-reveal/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { localUndoProps } from "@plugins/primitives/plugins/undo-redo/web";
import {
  BLOCK_INSET,
  useBlockActivate,
  usePageMarkdownContext,
  type BlockRendererProps,
} from "@plugins/page/plugins/editor/web";
import {
  parseMarkdownToForest,
  serializeForestToMarkdown,
  type MarkdownContext,
} from "@plugins/page/plugins/editor/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { tableBlock, type TableData } from "../../core";
import { TableView } from "./table-view";

const editSourceIcon = symbol("code");

/** The table's GFM, exactly as `read_page` would write it. */
function tableSource(data: TableData, ctx: MarkdownContext): string {
  return serializeForestToMarkdown(
    [{ type: tableBlock.type, data, expanded: true, children: [] }],
    ctx,
  );
}

type SourceParse = { ok: true; data: TableData } | { ok: false; error: string };

/**
 * Read an edited source back through the page's own markdown parser — the SAME
 * reading a paste or an agent's `edit_page` gets — and accept it only when it is
 * exactly one table: anything else (a declined delimiter row, prose around it,
 * two tables) is refused rather than half-applied.
 */
function parseTableSource(text: string, ctx: MarkdownContext): SourceParse {
  const forest = parseMarkdownToForest(text.trim(), ctx);
  const [node] = forest;
  if (
    forest.length !== 1 ||
    node === undefined ||
    node.type !== tableBlock.type ||
    node.children.length > 0
  ) {
    return {
      ok: false,
      error:
        "Not a table: write one GFM table — a header row, a delimiter row like | --- | --- |, then body rows.",
    };
  }
  const parsed = tableBlock.safeParse(node.data);
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid table." };
}

/**
 * The table block: its static `TableView`, plus an in-place SOURCE mode that
 * edits the table as the GFM an agent reads and writes.
 *
 * A void block (`caret: "editor"`): the host owns the caret, the cue, ↑/↓,
 * Backspace and Escape on the box. The one meaning this block adds is Enter —
 * registered through `useBlockActivate`, so Enter (and Space) on the focused
 * table opens its source, as does the hover button.
 *
 * The source is a local DRAFT, not a per-keystroke row write: an intermediate
 * keystroke is almost never a valid table. It commits on blur, Escape or
 * mod+Enter — ONE `editor.update`, so one undo entry — and an invalid source
 * stays open with the error and writes nothing. While drafting, ⌘Z belongs to
 * the textarea's own browser history (`localUndoProps`): the page stack has
 * nothing to undo until the commit records it.
 */
export function TableBlock({ block, editor }: BlockRendererProps) {
  const data = tableBlock.parse(block.data);
  const markdownContext = usePageMarkdownContext();
  const [draft, setDraft] = useState<{
    text: string;
    error: string | null;
  } | null>(null);
  // Whether a draft is open RIGHT NOW, read synchronously: Escape commits and
  // unmounts the textarea, and the blur that removal may fire must not commit
  // the same draft a second time from its stale closure.
  const open = useRef(false);

  function openSource() {
    open.current = true;
    setDraft({ text: tableSource(data, markdownContext()), error: null });
  }
  useBlockActivate(draft ? null : openSource);

  function commit(text: string) {
    if (!open.current) return;
    const parsed = parseTableSource(text, markdownContext());
    if (!parsed.ok) {
      setDraft({ text, error: parsed.error });
      return;
    }
    open.current = false;
    setDraft(null);
    // An unchanged source closes without recording an edit nobody made.
    if (
      tableSource(parsed.data, markdownContext()) !==
      tableSource(data, markdownContext())
    ) {
      editor.update(parsed.data);
    }
  }

  if (draft === null) {
    return (
      <div className={hoverRevealGroup}>
        <TableView
          data={data}
          overlay={
            <Pin to="top-right" offset="xs" layer="raised">
              <IconButton
                icon={editSourceIcon}
                label="Edit source"
                tooltip="Edit as markdown"
                className={cn(
                  hoverRevealTarget,
                  "bg-background/80 backdrop-blur",
                )}
                onClick={openSource}
              />
            </Pin>
          }
        />
      </div>
    );
  }

  return (
    <Inset x={BLOCK_INSET} y="xs">
      <Stack gap="xs">
        <textarea
          {...localUndoProps}
          aria-label="Table source"
          autoFocus
          spellCheck={false}
          value={draft.text}
          rows={draft.text.split("\n").length + 1}
          onChange={(e) => setDraft({ text: e.target.value, error: null })}
          onBlur={(e) => commit(e.currentTarget.value)}
          onKeyDown={(e) => {
            // The caret host around this block runs ↑/↓ and Escape wherever
            // they originate. In the source they belong to the textarea:
            // arrows move through its lines, Escape commits.
            if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.stopPropagation();
              return;
            }
            if (
              e.key === "Escape" ||
              (e.key === "Enter" && (e.metaKey || e.ctrlKey))
            ) {
              e.preventDefault();
              commit(e.currentTarget.value);
            }
          }}
          className={cn(
            "focus-ring w-full resize-y rounded-md border border-border bg-muted p-sm",
            textVariantClass("code"),
            "whitespace-pre [tab-size:2]",
          )}
        />
        {draft.error ? (
          <Text as="div" variant="caption" tone="destructive" role="alert">
            {draft.error}
          </Text>
        ) : null}
      </Stack>
    </Inset>
  );
}
