import { Icon } from "@plugins/ui/plugins/icons/web";

import { WithTooltip } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { useNow } from "@plugins/primitives/plugins/relative-time/web";
import { useSleepNowForFold } from "@plugins/infra/plugins/host/plugins/machine-sleep/web";
import type { ConversationItemConv } from "@plugins/conversations/plugins/conversation-ui/plugins/item/web";
import type { OpKind } from "@plugins/infra/plugins/worktree/core";
import type { OpRow } from "@plugins/debug/plugins/profiling/plugins/op-log/plugins/op-store/core";
import { useWorktreeOp } from "../internal/use-worktree-op";
import { stateLine } from "../internal/op-lines";
import { symbol, type IconRef } from "@plugins/ui/plugins/icons/core";

const buildIcon = symbol("build");
const checklistIcon = symbol("checklist");
const hourglassEmptyIcon = symbol("hourglass-empty");
const openInBrowserIcon = symbol("open-in-browser");
const scienceIcon = symbol("science");
const uploadIcon = symbol("upload");

// One icon per kind. Icons are React components, so they cannot live beside the
// kind's label in `OP_KINDS` (a web-safe core barrel with no react); the
// `Record<OpKind, …>` is what keeps this map complete — a kind declared there
// and not here is a type error, not a blank row.
const OP_ICON: Record<OpKind, IconRef> = {
  build: buildIcon,
  push: uploadIcon,
  check: scienceIcon,
  test: checklistIcon,
  e2e: openInBrowserIcon,
};

// The banner's state line, ticking. Mounted only while the tooltip is open, so
// a list of chips runs no clock until one is hovered.
function StateLineTooltip({ op }: { op: OpRow }) {
  const now = useNow(1000);
  const sleepNow = useSleepNowForFold();
  return <>{stateLine(op, now, sleepNow)}</>;
}

// Sidebar row indicator surfacing a worktree's in-flight op as a single muted
// icon: the hourglass whenever the op is parked in a wait (before its grant or
// after it), else the kind's icon; the tooltip is the banner's state line.
// Renders nothing when the worktree is idle, so ordinary "working" rows stay
// unadorned — and nothing while the ops are still loading (they are
// boot-preloaded, so that window is normally never seen): an optional row
// adornment has no loading affordance of its own.
export function OpStatusChip({ conv }: { conv: ConversationItemConv }) {
  const reading = useWorktreeOp(conv.id);
  if (reading.status === "loading") return null;
  if (reading.status === "error")
    return (
      <ResourceErrorInline
        variant="icon"
        subject="the worktree op"
        error={reading.error}
        refetch={reading.refetch}
      />
    );
  // No computer behind this app: no ops to flag — an optional adornment, so
  // nothing (the unavailability is not this chip's to explain).
  if (reading.status === "unavailable") return null;
  const op = reading.data;
  if (!op) return null;
  return (
    <WithTooltip content={<StateLineTooltip op={op} />}>
      <Inline gap="none" className="text-muted-foreground">
        {/* The density group's `opStatusIcon` (default 14px). */}
        <Icon
          icon={op.openWait !== null ? hourglassEmptyIcon : OP_ICON[op.kind]}
          className="size-op-status-icon"
        />
      </Inline>
    </WithTooltip>
  );
}
