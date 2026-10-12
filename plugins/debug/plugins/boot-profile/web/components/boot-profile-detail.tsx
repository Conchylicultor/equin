import { type ReactElement } from "react";
import { useLiveRow } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { bootTrace } from "../../core";
import { BootProfileGantt } from "./boot-profile-gantt";

// The `id` column is a uuid. A non-uuid id (a hand-typed or stale URL) can name
// no row — and would make the point read a Postgres cast error — so it is read
// as nothing: the same graceful not-found as an unknown-but-valid uuid.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Detail render of a saved snapshot. Reads the full blob by id, then paints it
// through the SAME pure Gantt as the live capture, with a read-only banner in
// place of the live controls.
export function BootProfileDetail({ id }: { id: string }): ReactElement {
  const result = useLiveRow(bootTrace, UUID_RE.test(id) ? id : null);

  if (result.status === "loading") {
    return (
      <Center axis="both" className="h-full">
        <Loading />
      </Center>
    );
  }

  if (result.status === "error") {
    return (
      <Center axis="both" className="h-full p-2xl text-center">
        <ResourceErrorInline
          variant="block"
          subject="the boot trace"
          error={result.error}
          refetch={result.refetch}
        />
      </Center>
    );
  }

  if (!result.found) {
    return (
      <Center axis="both" className="h-full p-2xl text-center">
        <Placeholder tone="muted">
          {`No saved boot trace with id "${id}".`}
        </Placeholder>
      </Center>
    );
  }

  const data = result.row;

  const banner = (
    // eslint-disable-next-line layout/no-adhoc-layout -- banner strip mirrors the live header strip
    <div className="flex items-center gap-sm border-b px-lg py-sm">
      <Text as="span" variant="caption" className="text-muted-foreground">
        Saved snapshot ·{" "}
      </Text>
      <Text as="span" variant="caption" className="text-muted-foreground">
        <RelativeTime date={data.createdAt} />
      </Text>
      <Text
        as="span"
        variant="caption"
        className="font-mono text-muted-foreground"
      >
        · {data.worktree}
      </Text>
    </div>
  );

  return <BootProfileGantt trace={data.snapshot} header={banner} />;
}
