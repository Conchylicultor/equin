import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { useLiveRow } from "@plugins/network/plugins/live/web";
import {
  CollapsibleChevron,
  FoldMotion,
  useCollapsible,
} from "@plugins/primitives/plugins/collapsible/web";
import type { Conversation as ConversationRecord } from "@plugins/tasks/plugins/tasks-core/core";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { turnSummaryRows } from "../../shared";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const warningIcon = symbol("warning");
const arrowForwardIcon = symbol("arrow-forward");

function parseBullets(text: string): string[] {
  if (!text.trim()) return [];
  const out: string[] = [];
  let buf: string[] = [];
  const flush = () => {
    if (buf.length) {
      out.push(buf.join(" ").trim());
      buf = [];
    }
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/g, "");
    const m = line.match(/^\s*[-*+]\s+(.*)$/);
    if (m && m[1] !== undefined) {
      flush();
      buf.push(m[1]);
    } else if (line.trim() === "") {
      flush();
    } else if (buf.length) {
      buf.push(line.trim());
    } else if (out.length === 0) {
      // Leading non-bullet text — treat as a single item.
      buf.push(line.trim());
    }
  }
  flush();
  return out.filter(Boolean);
}

export function TurnSummaryCard({
  conversation,
}: {
  conversation: ConversationRecord;
}) {
  const result = useLiveRow(turnSummaryRows, conversation.id);
  const { open, triggerProps, contentProps } = useCollapsible({
    defaultOpen: true,
  });
  // Not loaded yet and "no summary yet" both render nothing: the card is an
  // optional banner, and there is no stand-in summary to show in either case.
  if (result.status === "loading") return null;
  if (result.status === "error")
    return (
      <ResourceErrorInline
        variant="inline"
        subject="the turn summary"
        error={result.error}
        refetch={result.refetch}
      />
    );
  if (!result.found) return null;
  const summary = result.row;

  const caveats = parseBullets(summary.caveats);
  const actions = parseBullets(summary.actions);
  const hasDetail = caveats.length > 0 || actions.length > 0;

  return (
    <Text
      as="div"
      variant="caption"
      className="rounded-md border border-border bg-muted/30 px-md py-sm"
    >
      {/* The button hosts identity (type/aria/click); the row layout is the
          Stack inside it — the summary text wraps, so this is a flow row and NOT
          a single-line `Line` (whose whitespace-nowrap would defeat the wrap). */}
      <button
        {...(hasDetail ? triggerProps : { type: "button" })}
        className={cn(
          "w-full text-left",
          // No detail to open: this turn's card is a readout, so it keeps the
          // arrow the base rule hands every other button the hand for.
          !hasDetail && "cursor-default",
        )}
      >
        <Stack direction="row" gap="xs" align="start">
          {hasDetail ? (
            <CollapsibleChevron
              open={open}
              // eslint-disable-next-line spacing/no-adhoc-spacing -- tiny top offset to baseline-align the chevron with the first line of summary text
              className={cn(
                "mt-0.5 size-3.5 text-muted-foreground",
                rigidClass(),
              )}
            />
          ) : (
            // eslint-disable-next-line spacing/no-adhoc-spacing -- tiny top offset matching the chevron's, keeps the spacer placeholder aligned
            <span className={cn("mt-0.5 size-3.5", rigidClass())} />
          )}
          <Fill as="span">{summary.summary || "(no summary)"}</Fill>
        </Stack>
      </button>
      {hasDetail && (
        <FoldMotion {...contentProps}>
          {/* eslint-disable-next-line spacing/no-adhoc-spacing -- pt-2 separates this detail block from the always-visible summary button (inside the fold, so it tweens with it); ml-5 indents it under the chevron column */}
          <Stack gap="sm" className="pt-2 ml-5">
            {caveats.length > 0 && (
              <BulletList
                icon={
                  <Icon
                    icon={warningIcon}
                    // eslint-disable-next-line spacing/no-adhoc-spacing -- tiny top offset to baseline-align the bullet icon with its first text line
                    className={cn("mt-0.5 size-3 text-warning", rigidClass())}
                  />
                }
                items={caveats}
              />
            )}
            {actions.length > 0 && (
              <BulletList
                icon={
                  <Icon
                    icon={arrowForwardIcon}
                    // eslint-disable-next-line spacing/no-adhoc-spacing -- tiny top offset to baseline-align the bullet icon with its first text line
                    className={cn("mt-0.5 size-3 text-info", rigidClass())}
                  />
                }
                items={actions}
              />
            )}
          </Stack>
        </FoldMotion>
      )}
    </Text>
  );
}

function BulletList({
  icon,
  items,
}: {
  icon: React.ReactNode;
  items: string[];
}) {
  return (
    <Stack as="ul" gap="xs">
      {items.map((item, i) => (
        <Stack as="li" key={i} direction="row" gap="xs" align="start">
          {icon}
          <span>{item}</span>
        </Stack>
      ))}
    </Stack>
  );
}
