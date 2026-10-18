import type { ArtifactItem } from "@plugins/conversations/plugins/conversation-view/plugins/artifacts/core";
import { useLive } from "@plugins/network/plugins/live/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { browserRecordingRuns } from "../../core";
import { RunStrip } from "./run-strip";

/** The recordings' glyph. */
export const BROWSER_RECORDING_ICON = symbol("movie");

/**
 * Every browser drive the conversation recorded (e2e runs, browser_* calls), oldest first: the filmstrip each
 * run shows under its own tool call, gathered in one place. One read per call
 * (`useLive` over every call's tuple at once); a call that recorded nothing
 * (killed before its teardown) adds no strip.
 *
 * Like the screenshots section, the popover stays open under the viewer a
 * thumbnail opens — the viewer renders inside this section's tree.
 */
export function RecordingsSection({ items }: { items: ArtifactItem[] }) {
  const results = useLive(
    browserRecordingRuns,
    items.map((item) => ({ toolUseId: item.key })),
  );
  return (
    <Stack gap="sm" className="px-sm">
      {results.map((result, i) => {
        const key = items[i]?.key ?? String(i);
        if (result.status === "loading")
          return <Loading key={key} variant="block" />;
        if (result.status === "error")
          return (
            <ResourceErrorInline
              key={key}
              variant="inline"
              subject="a browser recording"
              error={result.error}
              refetch={result.refetch}
            />
          );
        return result.data.runs.map((run) => (
          <RunStrip key={run.dir} run={run} />
        ));
      })}
    </Stack>
  );
}
