import type { KeptText } from "@plugins/primitives/plugins/kept-state/core";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { SortableItem } from "@plugins/primitives/plugins/sortable-list/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import type { LaunchOptionValues } from "@plugins/tasks/plugins/launch-options/web";
import { TaskDraftComposer } from "./task-draft-composer";
import type { DependencyExtras } from "./dependency-pill";
import type { TaskChainRelateMode } from "@plugins/tasks/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

const dragIndicatorIcon = symbol("drag-indicator");

export interface TaskDraftCardProps {
  cardId: string;
  index: number;
  /** The card's text, a part of the host's kept chain draft. */
  keep: KeptText;
  /** Contributed launch-option values, keyed by option id. */
  launchOptions: LaunchOptionValues;
  autoFocus: boolean;
  /** Whether the card shows its drag grip — only when there is something to reorder against. */
  movable: boolean;
  disabled: boolean;
  onLaunchOptionsChange: (next: LaunchOptionValues) => void;
  onSubmitChord: () => void;
  isHead?: boolean;
  /** The head card's placeholder, from the host; omitted, the composer's own. */
  placeholder?: string | undefined;
  /**
   * Optional host-owned home for this card's insert-at-caret handle. Supplied for
   * the head card so the host can drive the same insertion path the card's own
   * action slot uses; omitted, the card keeps the handle to itself.
   */
  insertRef?:
    React.MutableRefObject<((snippet: string) => void) | null> | undefined;

  // Whether this card attaches the current page URL to the filed task. Every
  // card has the toggle — it is not a per-host capability.
  includeUrl: boolean;
  onToggleUrl: (v: boolean) => void;

  // Head-card-only relate toggle.
  relateMode?: TaskChainRelateMode | undefined;
  onRelateModeChange?: (next: TaskChainRelateMode | undefined) => void;
  showIndependentRelate?: boolean;
  /** The mode's extra choices, shown inside the Dependency menu. */
  relateExtras?: DependencyExtras | undefined;
}

export function TaskDraftCard({
  cardId,
  index,
  keep,
  launchOptions,
  autoFocus,
  movable,
  disabled,
  onLaunchOptionsChange,
  onSubmitChord,
  isHead = false,
  placeholder,
  insertRef: hostInsertRef,
  includeUrl,
  onToggleUrl,
  relateMode,
  onRelateModeChange,
  showIndependentRelate,
  relateExtras,
}: TaskDraftCardProps) {
  const showRelate = isHead && !!onRelateModeChange;

  return (
    <SortableItem
      id={cardId}
      handle
      wrapperProps={{ "data-card-index": index }}
      className={({ isDragging }) =>
        cn(
          // No border and no padding of its own: the composer field below is
          // the card's only box. This is the box that moves while dragging, and
          // what the grip is pinned to — the grip alone starts a drag, so
          // selecting text in the field never does.
          "group/card relative",
          isDragging && "opacity-50 shadow-lg",
        )
      }
    >
      {({ handleProps }) => (
        <Stack gap="none">
          <TaskDraftComposer
            cardId={cardId}
            keep={keep}
            launchOptions={launchOptions}
            autoFocus={autoFocus}
            disabled={disabled}
            onLaunchOptionsChange={onLaunchOptionsChange}
            onSubmitChord={onSubmitChord}
            isHead={isHead}
            placeholder={placeholder}
            insertRef={hostInsertRef}
            includeUrl={includeUrl}
            onToggleUrl={onToggleUrl}
            relate={
              showRelate
                ? {
                    value: relateMode,
                    onChange: onRelateModeChange!,
                    showIndependent: showIndependentRelate,
                    extras: relateExtras,
                  }
                : null
            }
          />
          {/* Always visible once there is a second card — a hover-only handle
              reads as "there is no handle" — and dimmed until the card is
              hovered. */}
          {movable && (
            <Pin to="top-right" offset="xs">
              <IconButton
                icon={dragIndicatorIcon}
                label="Drag to reorder"
                disabled={disabled}
                {...handleProps}
                className="cursor-grab opacity-60 transition-opacity focus-visible:opacity-100 active:cursor-grabbing group-hover/card:opacity-100"
              />
            </Pin>
          )}
        </Stack>
      )}
    </SortableItem>
  );
}
