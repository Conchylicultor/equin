import { useState, type DragEvent, type ReactNode } from "react";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { PlaceTag } from "@plugins/apps/plugins/places/plugins/places-core/core";
import {
  mergeRows,
  moveTag,
  removeTag,
  splitRow,
  type SidebarState,
} from "../internal/sidebar-filter";
import { TagChip } from "./tag-chip";

/** Where a dragged chip can land: an include row, or "and …" (a row of its own). */
type DropZone = number | "new";

export interface TagFilterBoxProps {
  state: SidebarState;
  /** The whole tag tree (chip names, marks, path tooltips). */
  tags: readonly PlaceTag[];
  onChange: (next: SidebarState) => void;
  /** A footer line under the rows (the preset's filter actions: Clear, Save …). */
  footer?: ReactNode;
}

/**
 * The sidebar's tag filter as an AND of OR-rows ("Tagged"), then the excluded
 * tags ("Not tagged"). Between two chips of a row sits an `or`: a click splits
 * the row there (both required). Between two rows sits an `and`: a click
 * merges them (either one). An included chip drags onto another row, or onto
 * the "and …" zone shown while dragging for a row of its own (HTML5 drag: the
 * chips move between containers, which the single-container sortable list
 * does not do). × removes a tag.
 */
export function TagFilterBox({
  state,
  tags,
  onChange,
  footer,
}: TagFilterBoxProps): ReactNode {
  const byId = new Map<string, PlaceTag>(tags.map((t) => [t.id, t]));
  const known = (ids: readonly string[]) =>
    ids.map((id) => byId.get(id)).filter((t): t is PlaceTag => !!t);

  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<DropZone | null>(null);
  const endDrag = () => {
    setDragging(null);
    setOver(null);
  };
  // A drop zone's handlers: it lights up under a dragged chip and moves it in.
  const dropZone = (zone: DropZone) => ({
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (dragging === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (over !== zone) setOver(zone);
    },
    onDragLeave: (e: DragEvent<HTMLElement>) => {
      const to = e.relatedTarget;
      if (to instanceof Node && e.currentTarget.contains(to)) return;
      if (over === zone) setOver(null);
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      if (dragging === null) return;
      e.preventDefault();
      onChange(moveTag(state, dragging, zone));
      endDrag();
    },
  });

  const excluded = known(state.exclude);
  return (
    <Surface level="sunken" className="rounded-lg p-sm">
      <Stack gap="xs">
        {state.rows.map((row, ri) => {
          const chips = known(row);
          return (
            <Cluster key={row.join(" ")} gap="xs">
              {ri === 0 ? (
                <Text variant="caption" tone="muted">
                  Tagged
                </Text>
              ) : (
                <Button
                  variant="ghost"
                  aspect="inline"
                  tooltip="either (or)"
                  onClick={() => onChange(mergeRows(state, ri - 1))}
                >
                  <Text variant="eyebrow" tone="muted">
                    and
                  </Text>
                </Button>
              )}
              <Cluster
                gap="2xs"
                {...dropZone(ri)}
                className={cn(
                  "rounded-lg border border-transparent p-2xs",
                  chips.length > 1 && "border-primary/20 bg-primary/5",
                  over === ri && "border-primary bg-primary/10",
                )}
              >
                {chips.map((tag, i) => (
                  <Cluster key={tag.id} gap="2xs">
                    {i > 0 ? (
                      <Button
                        variant="ghost"
                        aspect="inline"
                        tooltip="require both (and)"
                        onClick={() => onChange(splitRow(state, ri, i))}
                      >
                        <Text
                          variant="caption"
                          tone="primary"
                          className="italic"
                        >
                          or
                        </Text>
                      </Button>
                    ) : null}
                    <span
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", tag.name);
                        setDragging(tag.id);
                      }}
                      onDragEnd={endDrag}
                      className={cn(
                        "cursor-grab",
                        dragging === tag.id && "opacity-50",
                      )}
                    >
                      <TagChip
                        tag={tag}
                        tags={tags}
                        onRemove={() => onChange(removeTag(state, tag.id))}
                      />
                    </span>
                  </Cluster>
                ))}
              </Cluster>
            </Cluster>
          );
        })}
        {dragging !== null ? (
          <Cluster gap="xs">
            <Cluster
              {...dropZone("new")}
              className={cn(
                "rounded-full border border-dashed border-border px-sm py-2xs",
                over === "new" && "border-primary bg-primary/10",
              )}
            >
              <Text
                variant="caption"
                tone={over === "new" ? "primary" : "muted"}
              >
                and …
              </Text>
            </Cluster>
          </Cluster>
        ) : null}
        {excluded.length > 0 ? (
          <Cluster gap="xs">
            <Text variant="caption" tone="muted">
              Not tagged
            </Text>
            {excluded.map((tag) => (
              <TagChip
                key={tag.id}
                tag={tag}
                tags={tags}
                excluded
                onRemove={() => onChange(removeTag(state, tag.id))}
              />
            ))}
          </Cluster>
        ) : null}
        {footer === undefined ? null : (
          <Cluster gap="2xs" className="border-t pt-xs">
            {footer}
          </Cluster>
        )}
      </Stack>
    </Surface>
  );
}
