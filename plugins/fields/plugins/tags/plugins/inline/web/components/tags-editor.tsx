import { useRef, useState, type ReactNode } from "react";
import { transient } from "@plugins/primitives/plugins/kept-state/core";
import { InlinePopover } from "@plugins/primitives/plugins/overlay/plugins/popover/web";
import { Input } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { ToggleChip } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import type { CellEditorProps } from "@plugins/primitives/plugins/data-view/web";

function sameTags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Compact inline tags editor: an open-by-default popover. A free-text input adds
 * arbitrary tags on Enter; a toggle-chip grid (known `field.options` unioned with
 * the current selection) toggles membership. The accumulated array commits on
 * dismiss via `onCommitValues` — or cancels if unchanged (and on Esc).
 */
export function TagsEditor(props: CellEditorProps): ReactNode {
  const initial = props.values ? [...props.values] : [];
  const [open, setOpen] = useState(true);
  const [selected, setSelected] = useState<string[]>(initial);
  const [draft, setDraft] = useState("");
  const closed = useRef(false);
  const options = props.field.options ?? [];

  const labelFor = (v: string) =>
    options.find((o) => o.value === v)?.label ?? v;

  function add(tag: string) {
    const t = tag.trim();
    if (!t) return;
    setSelected((prev) => (prev.includes(t) ? prev : [...prev, t]));
    setDraft("");
  }
  function toggle(v: string) {
    setSelected((prev) =>
      prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v],
    );
  }
  function finish(commit: boolean) {
    if (closed.current) return;
    closed.current = true;
    setOpen(false);
    if (commit && !sameTags(selected, initial)) props.onCommitValues(selected);
    else props.onCancel();
  }

  const optionValues = options.map((o) => o.value);
  const allValues = [
    ...optionValues,
    ...selected.filter((v) => !optionValues.includes(v)),
  ];
  const draftLc = draft.trim().toLowerCase();
  const visible = draftLc
    ? allValues.filter(
        (v) =>
          labelFor(v).toLowerCase().includes(draftLc) ||
          v.toLowerCase().includes(draftLc),
      )
    : allValues;

  return (
    <InlinePopover
      open={open}
      onOpenChange={(next) => {
        if (!next) finish(true);
        else setOpen(true);
      }}
      width="md"
      trigger={
        <Clip className="whitespace-nowrap">
          <Stack direction="row" gap="xs">
            {selected.length === 0 ? (
              <span className="italic text-muted-foreground/50">Empty</span>
            ) : (
              selected.map((t) => (
                <Badge key={t} variant="muted">
                  {labelFor(t)}
                </Badge>
              ))
            )}
          </Stack>
        </Clip>
      }
    >
      <Stack gap="sm">
        <Input
          autoFocus
          placeholder="Add tag…"
          keep={transient("a one-shot cell editor: the tag is added on Enter")}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add(draft);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              finish(false);
            }
          }}
        />
        {visible.length > 0 && (
          <Cluster gap="xs">
            {visible.map((v) => (
              <ToggleChip
                key={v}
                active={selected.includes(v)}
                variant="ghost"
                onClick={() => toggle(v)}
              >
                {labelFor(v)}
              </ToggleChip>
            ))}
          </Cluster>
        )}
      </Stack>
    </InlinePopover>
  );
}
