import {
  useCursorSelector,
  useSession,
} from "@plugins/apps/plugins/sonata/plugins/session/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  cn,
  ControlSizeProvider,
  SingleLineProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { yieldClass } from "@plugins/primitives/plugins/css/plugins/yield/web";
import { hoverRevealTarget } from "@plugins/primitives/plugins/hover-reveal/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { sectionDotClass } from "../section-model";

const repeatIcon = symbol("repeat");

/** The section's coloured dot (6px), shared by the label and the hover line. */
export function SectionDot({ name }: { name: string }) {
  return (
    <ControlSizeProvider size="sm">
      <StatusDot colorClass={sectionDotClass(name)} />
    </ControlSizeProvider>
  );
}

/** `● name` — the hover preview's section line. */
export function SectionDescription({ name }: { name: string }) {
  return (
    <Inline gap="xs">
      <SectionDot name={name} />
      {name}
    </Inline>
  );
}

/**
 * One section's label in the progress bar's label lane: dot + name, the
 * current section strong (the rest muted); click seeks to its start.
 *
 * An inline row that yields below its content, so the lane can fold it beside
 * other same-beat items (a key name) and still ellipsize the name when the
 * section is narrow. The hover highlight is the lane group's — the whole
 * section's width — not this row's. "Current" is a boundary-crossing selector
 * over the cursor, so playback re-renders a label only when it enters or
 * leaves it.
 */
export function SectionLabel({
  name,
  start,
  end,
}: {
  name: string;
  start: number;
  end: number;
}) {
  const { seekTo } = useSession();
  const current = useCursorSelector(
    (beat) => beat >= start && beat < end,
    [start, end],
  );

  return (
    <SingleLineProvider value={true}>
      <Inline
        as="button"
        gap="xs"
        title={name}
        className={cn(yieldClass("x"), "px-xs")}
        onClick={(e) => {
          e.stopPropagation();
          seekTo(start);
        }}
      >
        <Text
          tone={current ? "strong" : "muted"}
          // eslint-disable-next-line text/no-adhoc-typography -- the label lane is 13px tall: line-height must stay 1 and the size below the caption role
          className={cn("text-3xs leading-none", current && "font-bold")}
        >
          {name}
        </Text>
      </Inline>
    </SingleLineProvider>
  );
}

/**
 * "Loop this section": pinned to the right end of the section's lane group
 * (`align: "end"`) and revealed while that group is hovered — the lane makes
 * every group a `hoverRevealGroup`. Sets the shared A–B loop onto the section
 * and seeks to its start.
 */
export function SectionLoopButton({
  start,
  end,
}: {
  start: number;
  end: number;
}) {
  const { setLoop, seekTo } = useSession();
  return (
    <span className={hoverRevealTarget}>
      <ControlSizeProvider size="xs">
        <IconButton
          icon={repeatIcon}
          label="Loop this section"
          onClick={(e) => {
            e.stopPropagation();
            setLoop({ start, end, enabled: true });
            seekTo(start);
          }}
        />
      </ControlSizeProvider>
    </span>
  );
}
