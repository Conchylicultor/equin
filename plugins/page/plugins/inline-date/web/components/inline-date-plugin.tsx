import { useMemo } from "react";
import {
  $createTextNode,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
} from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  atWordBoundary,
  CaretTriggerMenu,
  useCaretMenu,
  useCaretQuery,
} from "@plugins/primitives/plugins/text-editor/plugins/caret-trigger/web";
import { type BlockTextPluginProps } from "@plugins/page/plugins/editor/web";
import { $createDateMentionNode } from "./date-mention-node";
import {
  buildMenu,
  type DateOption,
  type MenuModel,
} from "../internal/date-options";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const calendarTodayIcon = symbol("calendar-today");
const notificationsActiveIcon = symbol("notifications-active");

/** The menu while its trigger is closed: nothing to offer, nothing computed. */
const CLOSED_MENU: MenuModel = { open: false, hint: false, options: [] };

/**
 * Inline, Notion-style `@` date/reminder typeahead, built on the shared
 * caret-trigger primitive: open-state + query are DERIVED from the live editor
 * text (never a latch — see the primitive's CLAUDE.md); arrows/Enter navigate,
 * Esc / outside-press dismiss; the menu renders through `CaretTriggerMenu`,
 * caret-anchored since `@` appears mid-line.
 *
 * The query filters the relative presets (Today / Tomorrow / Yesterday) AND is
 * parsed by chrono into a concrete instant — so the preset vocabulary the menu
 * advertises at rest stays reachable as you type it (`@tod` still offers a
 * pressable `Today`). Selecting the "date" row inserts a `[[date:<iso>]]` chip;
 * the "reminder" row mints a UUID and inserts a `[[reminder:<id>:<iso>]]` chip
 * that the server schedules a notification for. A footer states the grammar
 * chrono accepts, since a menu that just closes on an unparseable query reads as
 * a bug rather than as guidance.
 */
export function InlineDatePlugin(_: BlockTextPluginProps) {
  const [lexicalEditor] = useLexicalComposerContext();

  function insertMention(option: DateOption) {
    const iso = option.date.toISOString();
    const reminderId = option.kind === "reminder" ? crypto.randomUUID() : null;
    lexicalEditor.update(() => {
      const sel = $getSelection();
      if (!$isRangeSelection(sel) || !sel.isCollapsed()) return;
      const node = sel.anchor.getNode();
      if (!$isTextNode(node)) return;
      const full = node.getTextContent();
      const caretOffset = sel.anchor.offset;
      const idx = full.slice(0, caretOffset).lastIndexOf("@");
      if (idx === -1) return;
      const head = full.slice(0, idx);
      const tail = full.slice(caretOffset);
      node.setTextContent(head);
      const mention = $createDateMentionNode(iso, reminderId);
      const space = $createTextNode(" ");
      node.insertAfter(mention);
      mention.insertAfter(space);
      if (tail) space.insertAfter($createTextNode(tail));
      // Caret immediately after the inserted space.
      space.select(1, 1);
    });
  }

  const caret = useCaretQuery({
    id: "date",
    trigger: "@",
    canOpen: atWordBoundary,
    isQueryValid: (q) => !/[@\n]/.test(q) && buildMenu(q, new Date()).open,
  });

  // `buildMenu` runs here for RENDER (the option rows) and again inside
  // `isQueryValid` for the OPEN gate — the same double evaluation the old
  // sync()+render performed; the model is deliberately not threaded through the hook.
  // Only while the trigger is open: this plugin is mounted on every line of a
  // page, and a closed menu's presets (each formatted through Intl) cost a long
  // page's opening commit ~25 ms for rows nobody sees.
  const menu = useMemo(
    () => (caret.open ? buildMenu(caret.query, new Date()) : CLOSED_MENU),
    [caret.open, caret.query],
  );
  const options = menu.options;

  const { surfaceOpen, activeIndex, setActiveIndex, commit } = useCaretMenu(
    caret,
    {
      itemCount: options.length,
      onCommit: (i) => insertMention(options[i]!),
    },
  );

  return (
    <CaretTriggerMenu caret={caret} open={surfaceOpen} width="lg" padding="xs">
      <Stack gap="none">
        {/* eslint-disable-next-line data-view/no-adhoc-row-list -- caret typeahead menu (transient chrome) */}
        {options.map((option, i) => (
          <Row
            key={`${option.kind}-${i}`}
            selected={i === activeIndex}
            icon={
              option.kind === "reminder" ? (
                <Icon
                  icon={notificationsActiveIcon}
                  className="text-muted-foreground"
                />
              ) : (
                <Icon
                  icon={calendarTodayIcon}
                  className="text-muted-foreground"
                />
              )
            }
            onMouseEnter={() => setActiveIndex(i)}
            // Commit on pointerdown through the menu's `commit` (pointerdown-
            // timed + `editor.update`-wrapped), so a click matches Enter — a
            // mousedown-time commit would never fire (the press perturbs the
            // caret and unmounts this row first). See `useCaretMenu`.
            onPointerDown={(e: React.PointerEvent) => {
              e.preventDefault();
              commit(i);
            }}
          >
            {/* The label owns the slack; `detail` (the absolute day behind a
                relative label) sits in its own rigid track, never floated over
                the label — the overlap rule in the `css` skill. */}
            <Fill>
              <Text>{option.label}</Text>
            </Fill>
            {option.detail ? (
              <Text variant="caption" tone="muted">
                {option.detail}
              </Text>
            ) : null}
          </Row>
        ))}
        {/* Persistent grammar footer — the accepted formats are otherwise
            invisible, and a menu that silently closes on an unparseable query
            reads as a bug. Shown in the hint state too (where it is the only
            content), so "keep typing" always says WHAT to type. */}
        <Inset
          pad="xs"
          className={cn(options.length > 0 && "border-border border-t")}
        >
          <Text variant="caption" tone="muted">
            tomorrow · next fri 3pm · jun 17 · 2026-06-17
          </Text>
        </Inset>
      </Stack>
    </CaretTriggerMenu>
  );
}
