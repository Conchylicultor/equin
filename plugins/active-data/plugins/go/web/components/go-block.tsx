import { useState, type ReactNode } from "react";
import { z } from "zod";
import { useActiveDataBinding } from "@plugins/active-data/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { usePromptComposer } from "@plugins/conversations/plugins/conversation-view/web";
import { Markdown } from "@plugins/primitives/plugins/markdown/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  Button,
  cn,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  goDraft,
  goWire,
  parseGo,
  type GoBody,
  type GoItem,
} from "../internal/parse-go";
import { editIcon, GO_TINT, GoRailCap, sendIcon } from "./go-cap";
import { GoItemText } from "./go-item-text";
import { GoTable } from "./go-table";
import { PickedBox } from "./picked-box";

const resetIcon = symbol("restart-alt");
/** How far a checklist item's words sit past its box: `PickedBox`'s size-3 + pr-xs. */
const BOX_HANG = "calc(0.75rem + var(--space-xs))";

/**
 * A multi-line `<go>`: the suggestion as a tinted card with its actions as a
 * rail on the right — ✎ puts it in the draft, ▶ sends it (a checklist has no
 * text to click, unlike an inline Go). A `- [ ]` checklist inside becomes
 * pickable rows, and so does a table whose rows lead with `[ ]` / `[x]` (a
 * pick table); ▶ sends only the picked lines (the prose is for the reader)
 * and stays unsendable until one is picked (✎ with none picked hands over
 * every item to trim). Once the picks differ from the agent's own, Reset
 * puts them back.
 */
export function GoBlock({
  content,
}: {
  content: string;
  attrs: Record<string, string>;
}) {
  const body = parseGo(content);
  if (body.items.length === 0) {
    const wire = goWire(content, []);
    return (
      <GoCard wire={wire} draft={wire} ready>
        <Markdown>{content}</Markdown>
      </GoCard>
    );
  }
  return <GoChecklist content={content} body={body} />;
}

/** The picks, persisted per occurrence so they survive a transcript reload. */
const PicksSchema = z.object({ picked: z.array(z.boolean()) });

function GoChecklist({ content, body }: { content: string; body: GoBody }) {
  const binding = useActiveDataBinding(PicksSchema);
  // The picks made in this mount, shown at once while the write lands — and
  // the only store for a legacy log, which has no binding identity.
  const [local, setLocal] = useState<boolean[] | null>(null);

  if (binding.enabled && local === null) {
    if (binding.value.status === "loading") return <Loading variant="text" />;
    if (binding.value.status === "error") {
      return (
        <ResourceErrorInline
          error={binding.value.error}
          refetch={binding.value.refetch}
          variant="inline"
        />
      );
    }
  }
  const stored =
    binding.enabled && binding.value.status === "ready"
      ? binding.value.data?.picked
      : undefined;
  const initial = body.items.map((i) => i.checked);
  // A stored pick list of another length belongs to other content: ignore it.
  const picked =
    local ?? (stored?.length === body.items.length ? stored : initial);

  const pick = (next: boolean[]) => {
    setLocal(next);
    if (binding.enabled) void binding.set({ picked: next });
  };
  const toggle = (i: number) =>
    pick(picked.map((on, j) => (j === i ? !on : on)));

  const count = picked.filter(Boolean).length;
  const changed = picked.some((on, i) => on !== initial[i]);
  return (
    <GoCard
      wire={goWire(content, picked)}
      draft={goWire(content, count === 0 ? body.items.map(() => true) : picked)}
      ready={count > 0}
    >
      {body.lead && <Markdown>{body.lead}</Markdown>}
      {body.head ? (
        <GoTable
          head={body.head}
          items={body.items}
          picked={picked}
          onToggle={toggle}
          onToggleAll={() => pick(picked.map(() => !picked.every(Boolean)))}
        />
      ) : (
        <Stack gap="none">
          {body.items.map((item, i) => (
            <GoItemRow
              key={i}
              item={item}
              checked={picked[i]!}
              onToggle={() => toggle(i)}
            />
          ))}
        </Stack>
      )}
      {body.tail && <Markdown>{body.tail}</Markdown>}
      <Stack direction="row" gap="sm" align="center">
        <Text variant="caption" tone="muted" className="select-none">
          {count === 0
            ? "Check the ones to send"
            : `${count} of ${picked.length} checked`}
        </Text>
        {changed && (
          <ControlSizeProvider size="xs">
            <Button
              variant="ghost"
              title="Back to the agent's picks"
              onClick={() => pick(initial)}
              className="select-none text-muted-foreground"
            >
              <Icon icon={resetIcon} />
              Reset
            </Button>
          </ControlSizeProvider>
        )}
      </Stack>
    </GoCard>
  );
}

/**
 * The block's frame: the tinted card, and — where there is a prompt to reach
 * (a conversation pane) — its ✎ / ▶ rail.
 */
function GoCard({
  wire,
  draft,
  ready,
  children,
}: {
  /** What ▶ sends. */
  wire: string;
  /** What ✎ puts in the draft. */
  draft: string;
  /** Whether there is anything to send yet; ✎ stays live regardless. */
  ready: boolean;
  children: ReactNode;
}) {
  const composer = usePromptComposer();
  return (
    // Clipped so the rail's fill follows the card's rounded corners.
    <Clip className={cn("rounded-md", GO_TINT)}>
      <Stack direction="row" gap="none" align="stretch">
        <Fill>
          <Stack gap="xs" className="px-md py-sm">
            {children}
          </Stack>
        </Fill>
        {composer && (
          <Stack gap="none" className="border-l border-foreground/10">
            <GoRailCap
              icon={editIcon}
              label="Edit in the prompt"
              onAction={() => composer.insert(goDraft(draft))}
            />
            <GoRailCap
              icon={sendIcon}
              label={ready ? "Send" : "Check the ones to send"}
              disabled={!ready || !composer.canSend}
              onAction={() => composer.send(wire)}
            />
          </Stack>
        )}
      </Stack>
    </Clip>
  );
}

function GoItemRow({
  item,
  checked,
  onToggle,
}: {
  item: GoItem;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    // A block of inline text, not a <button> or a flex row: a button's words
    // cannot be selected, and a row declared as one copy unit is selected
    // whole. The box is an inline token that copies as `- [ ] `, the words
    // ordinary text — so a drag selects words, and a copy yields the line the
    // agent wrote. A click that ends a selection is not a toggle.
    <span
      role="checkbox"
      tabIndex={0}
      aria-checked={checked}
      onClick={() => {
        if (String(window.getSelection() ?? "")) return;
        onToggle();
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        onToggle();
      }}
      // A hanging indent: a wrapped line starts under the words, past the
      // box. Descendants reset it — an inline-block chip would inherit it.
      style={{
        paddingInlineStart: `calc(var(--space-xs) + ${BOX_HANG})`,
        textIndent: `calc(-1 * ${BOX_HANG})`,
      }}
      className="block cursor-pointer rounded-sm px-xs py-2xs transition-colors hover:bg-primary/10 [&_*]:indent-0"
    >
      <PickedBox checked={checked} />
      <GoItemText text={item.text} />
    </span>
  );
}
