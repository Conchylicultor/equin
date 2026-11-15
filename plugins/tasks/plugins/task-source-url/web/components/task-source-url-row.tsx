import { useLive } from "@plugins/network/plugins/live/web";
import { FileLinkText } from "@plugins/primitives/plugins/file-links/web";
import {
  SectionLabel,
  Text,
} from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { taskSourceUrls } from "../../core";

/**
 * The task header's "Filed from" row: the page the task was filed from, as a
 * link. Rendered only once the stored url is read and exists — a task filed
 * without the Page URL toggle has no row (the header's other rows are what a
 * task always has).
 */
export function TaskSourceUrlRow({ taskId }: { taskId: string }) {
  const read = useLive(taskSourceUrls, { id: taskId });
  if (read.status === "error") throw read.error;
  if (read.status === "loading" || !read.found) return null;
  return (
    <Stack direction="row" align="center" gap="md">
      <SectionLabel as="span">Filed from</SectionLabel>
      {/* A long url ellipsizes on one line; the tooltip holds it whole. */}
      <Fill>
        <Line>
          <Text variant="caption" title={read.row.url}>
            <FileLinkText text={read.row.url} />
          </Text>
        </Line>
      </Fill>
    </Stack>
  );
}
