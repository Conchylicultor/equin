import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useState, type ReactElement, type ReactNode } from "react";
import {
  ControlPanel,
  ControlPanelPopover,
} from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { EmojiPicker } from "@plugins/ui/plugins/icons/plugins/emoji/web";
import {
  EmojiSchema,
  type Emoji,
} from "@plugins/ui/plugins/icons/plugins/emoji/core";
import { PageIcon } from "@plugins/page/plugins/editor/web";
import { ResourceView } from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  useRecentUsage,
  useRecordUsage,
} from "@plugins/primitives/plugins/usage-rank/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const closeIcon = symbol("close");

/** The usage-rank namespace a picked page icon is recorded under. */
const PAGE_ICON_USAGE = "page-icon";
/** How many recent icons lead the grid: two rows of nine. */
const RECENT_COUNT = 18;

export interface PageIconValue {
  icon: Emoji | null;
}

/**
 * Extra rows for the picker's footer, rendered above "Remove" — the extension
 * point for an action that belongs beside Remove (a "Regenerate" from the
 * page's auto-icon). Handed `close` so a row can dismiss the picker once it
 * has acted. Each row is a `ControlPanel.Row`.
 */
export type PageIconFooterActions = (ctx: { close: () => void }) => ReactNode;

/**
 * The emoji-picker popover, decoupled from its trigger. Picking commits
 * immediately and closes; "Remove" clears the icon back to the default glyph
 * (only offered when an icon is set); `footerActions` adds rows above it. The `trigger` is any element — a large
 * page icon or a small "Add icon" affordance — so both entry points share one
 * picker.
 *
 * It is a `ControlPanelPopover` whose grid section declares `needs="picker"`, so the emoji block's search
 * field and grid inherit the panel's one content inset, and the rule above the
 * footer is drawn by the container rather than placed here. The grid is the
 * emoji picker's `panel` variant, led by a "Recent" row (see
 * `PageEmojiPicker`); every pick is recorded for that row's ranking.
 */
export function PageIconPicker({
  value,
  onChange,
  trigger,
  footerActions,
}: {
  value: PageIconValue;
  onChange: (next: PageIconValue) => void | Promise<void>;
  trigger: ReactElement;
  footerActions?: PageIconFooterActions;
}) {
  const [open, setOpen] = useState(false);
  const recordUsage = useRecordUsage();
  const hasIcon = value.icon != null;
  const close = () => setOpen(false);

  return (
    <ControlPanelPopover
      open={open}
      onOpenChange={setOpen}
      align="start"
      label="Page icon"
      trigger={trigger}
    >
      {/* No section label: the picker's search field leads the panel. */}
      <ControlPanel.Section needs="picker">
        <PageEmojiPicker
          value={value.icon}
          onPick={(icon) => {
            recordUsage(PAGE_ICON_USAGE, icon);
            void onChange({ icon });
            close();
          }}
        />
      </ControlPanel.Section>
      {(hasIcon || footerActions) && (
        <ControlPanel.Footer>
          {footerActions?.({ close })}
          {hasIcon && (
            <ControlPanel.Row
              muted
              icon={<Icon icon={closeIcon} />}
              onSelect={() => {
                void onChange({ icon: null });
                close();
              }}
            >
              Remove
            </ControlPanel.Row>
          )}
        </ControlPanel.Footer>
      )}
    </ControlPanelPopover>
  );
}

/**
 * The large page header icon: a glyph that opens the icon picker on click.
 * Sized for the header's stacked-over-title treatment.
 */
export function PageIconButton({
  value,
  onChange,
  footerActions,
  className,
  style,
}: {
  value: PageIconValue;
  onChange: (next: PageIconValue) => void | Promise<void>;
  footerActions?: PageIconFooterActions;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <PageIconPicker
      value={value}
      onChange={onChange}
      footerActions={footerActions}
      trigger={
        <button
          type="button"
          aria-label="Change page icon"
          style={style}
          // eslint-disable-next-line layout/no-adhoc-layout -- rigid icon trigger in the page header's icon/title stack
          className={cn(
            "hover:bg-accent size-20 shrink-0 rounded-lg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
            className,
          )}
        >
          <Center className="size-full">
            {/* A 72px glyph: the emoji box is the size over the 85% an
                `EmojiGlyph` draws its character at. */}
            <PageIcon icon={value.icon} className="size-[calc(72px/0.85)]" />
          </Center>
        </button>
      }
    />
  );
}

/**
 * The picker body: the emoji grid drawn as a panel, led by a "Recent" row —
 * the icons last picked here, newest first (`usage-rank`, fed by every pick).
 * It waits for that row before mounting the grid, because the grid reads its
 * leading category once, at mount.
 */
function PageEmojiPicker({
  value,
  onPick,
}: {
  value: Emoji | null;
  onPick: (icon: Emoji) => void;
}) {
  const recent = useRecentUsage(PAGE_ICON_USAGE, RECENT_COUNT);
  return (
    <ResourceView resource={recent} fallback={<Loading variant="rows" />}>
      {(keys) => (
        <EmojiPicker
          variant="panel"
          value={value}
          // Every key was recorded from an `Emoji`; one that no longer parses
          // is corrupt data, and throws here rather than being drawn.
          leadingCategory={{
            label: "Recent",
            emojis: keys.map((key) => EmojiSchema.parse(key)),
          }}
          onSelect={onPick}
        />
      )}
    </ResourceView>
  );
}
