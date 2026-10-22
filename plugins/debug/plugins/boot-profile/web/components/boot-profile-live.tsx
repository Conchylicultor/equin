import { type ReactElement } from "react";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { useToast } from "@plugins/shell/plugins/notifications/web";
import {
  getBootTrace,
  refreshBootTrace,
  useBootTrace,
} from "@plugins/primitives/plugins/perfs/plugins/boot-trace/web";
import { saveBootTrace } from "../../shared/endpoints";
import { BootProfileGantt } from "./boot-profile-gantt";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const refreshIcon = symbol("refresh");
const replayIcon = symbol("replay");
const linkIcon = symbol("link");

// Live wrapper: owns the in-memory boot-trace subscription and the Refresh /
// Reload / Copy permalink controls. The Gantt itself is pure (takes `trace`),
// so the same renderer paints both this live capture and a DB-loaded snapshot.
export function BootProfileLive(): ReactElement {
  // Live trace via useSyncExternalStore — the store owns the subscription to late
  // paint timing (FCP / first-paint), the first React commit, and new boot spans
  // (push-based PerformanceObserver + subscriber set, no polling). The Refresh
  // button calls refreshBootTrace() to re-pull the lazily-read timing.
  const toast = useToast();
  const trace = useBootTrace();

  const save = useEndpointMutation(saveBootTrace);
  const onCopyPermalink = async (): Promise<void> => {
    // Persist the CURRENT live snapshot (not a stale captured copy), then copy a
    // worktree-scoped permalink. The URL keeps the worktree subdomain so the
    // snapshot resolves against the DB fork it was written to.
    const { id } = await save.mutateAsync({
      body: { snapshot: getBootTrace() },
    });
    const url = `${window.location.origin}/debug/boot-profile/${id}`;
    await navigator.clipboard.writeText(url);
    toast({
      type: "debug",
      title: "Permalink copied",
      description: url,
    });
  };

  const header = (
    // eslint-disable-next-line layout/no-adhoc-layout -- header strip mirrors gantt-view.tsx
    <div className="flex items-center gap-sm border-b px-lg py-sm">
      {/* eslint-disable-next-line layout/no-adhoc-layout -- flexible spacer pushing buttons to the right (mirrors gantt-view.tsx) */}
      <div className="flex-1" />
      <Button
        variant="ghost"
        onClick={() => void onCopyPermalink()}
        disabled={save.isPending}
      >
        <Icon icon={linkIcon} className="size-3.5" />
        {save.isPending ? "Saving…" : "Copy permalink"}
      </Button>
      <Button variant="ghost" onClick={() => refreshBootTrace()}>
        <Icon icon={refreshIcon} className="size-3.5" />
        Refresh
      </Button>
      <Button variant="ghost" onClick={() => window.location.reload()}>
        <Icon icon={replayIcon} className="size-3.5" />
        Reload & re-measure
      </Button>
    </div>
  );

  if (trace.spans.length === 0) {
    return (
      <Text
        as="div"
        variant="caption"
        className="px-lg py-sm text-muted-foreground"
      >
        No boot trace captured.
      </Text>
    );
  }

  return <BootProfileGantt trace={trace} header={header} />;
}
