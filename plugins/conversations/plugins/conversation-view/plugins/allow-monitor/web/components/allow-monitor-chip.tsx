import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { allowFiles } from "../../core";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const warningIcon = symbol("warning");

export function AllowMonitorChip() {
  const { convId } = conversationPane.useParams();
  const result = useLive(allowFiles, { id: convId });
  // An alarm, not a data display: nothing to show until the server has said a
  // bypass file exists. A failed read is shown, though: silence would claim no
  // bypass is active when nobody could check. Unavailable (a host without the
  // computer) is a stated arm, not an empty list: there is no worktree here,
  // so no guard runs and nothing could be bypassed — the alarm stays silent.
  if (result.status === "loading") return null;
  if (result.status === "unavailable") return null;
  if (result.status === "error")
    return (
      <ResourceErrorInline
        variant="icon"
        icon={warningIcon}
        subject="the guard-bypass files"
        error={result.error}
        refetch={result.refetch}
      />
    );
  const files = result.data.allowFiles;
  if (files.length === 0) return null;

  return (
    <Badge
      tooltipSide="bottom"
      tooltip={
        <>
          {/* eslint-disable-next-line spacing/no-adhoc-spacing -- heading offset inside a tooltip fragment with no flex parent to own the gap */}
          <p className="mb-1 font-semibold">Guard bypasses active:</p>
          {files.map((f) => (
            <Text as="p" variant="caption" key={f} className="font-mono">
              {f}
            </Text>
          ))}
        </>
      }
      as="button"
        colorClass="bg-destructive/90 text-white hover:bg-destructive"
        icon={<Icon icon={warningIcon} />}
        className="animate-pulse cursor-default"
        aria-label="Security bypass active"
      >
        BYPASS ACTIVE
    </Badge>
  );
}
