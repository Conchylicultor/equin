import { useState } from "react";
import { z } from "zod";
import { useActiveDataBinding } from "@plugins/active-data/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Markdown } from "@plugins/primitives/plugins/markdown/web";
import { InlineText } from "@plugins/primitives/plugins/inline-text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { CheckboxIndicator } from "@plugins/primitives/plugins/css/plugins/selection-indicator/web";
import { copiesAsText } from "@plugins/primitives/plugins/dom/plugins/copy-source-text/core";
import {
  goWire,
  parseGo,
  type GoBody,
  type GoItem,
} from "../internal/parse-go";
import { GoChip } from "./go-chip";

/**
 * A multi-line `<go>`: the suggested prompt as a tinted block with the Go chip
 * at its foot. A `- [ ]` checklist inside becomes pickable rows; the chip sends
 * only the picked lines (the prose is for the reader), and stays unsendable
 * until one is picked (✎ with none picked hands over every item to trim).
 */
export function GoBlock({
  content,
}: {
  content: string;
  attrs: Record<string, string>;
}) {
  const body = parseGo(content);
  if (body.items.length === 0) {
    return (
      <Stack gap="xs" className="rounded-md bg-primary/5 px-md py-xs">
        <Markdown>{content}</Markdown>
        <Stack direction="row" gap="none" justify="end">
          <GoChip wire={goWire(content, [])} />
        </Stack>
      </Stack>
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
  // A stored pick list of another length belongs to other content: ignore it.
  const picked =
    local ??
    (stored?.length === body.items.length
      ? stored
      : body.items.map((i) => i.checked));

  const toggle = (i: number) => {
    const next = picked.map((on, j) => (j === i ? !on : on));
    setLocal(next);
    if (binding.enabled) void binding.set({ picked: next });
  };

  const count = picked.filter(Boolean).length;
  return (
    <Stack gap="xs" className="rounded-md bg-primary/5 px-md py-sm">
      {body.lead && <Markdown>{body.lead}</Markdown>}
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
      {body.tail && <Markdown>{body.tail}</Markdown>}
      <Stack direction="row" gap="sm" align="center" justify="end">
        <Text variant="caption" tone="muted" className="select-none">
          {count === 0
            ? "Pick the ones to send"
            : `${count} of ${picked.length} picked`}
        </Text>
        <GoChip
          wire={goWire(content, picked)}
          draft={goWire(
            content,
            count === 0 ? body.items.map(() => true) : picked,
          )}
          ready={count > 0}
        />
      </Stack>
    </Stack>
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
    <Stack
      as="button"
      direction="row"
      gap="sm"
      align="start"
      role="checkbox"
      aria-checked={checked}
      onClick={onToggle}
      // Copies as the line the agent wrote, with its current tick.
      {...copiesAsText(`- [${checked ? "x" : " "}] ${item.text}\n`)}
      className="w-full rounded-sm px-xs py-2xs text-left transition-colors hover:bg-primary/10"
    >
      {/* pt-xs seats the box on the label's first line. */}
      <Stack gap="none" className="pt-xs">
        <CheckboxIndicator checked={checked} />
      </Stack>
      <Fill>
        <InlineText text={item.text} />
      </Fill>
    </Stack>
  );
}
