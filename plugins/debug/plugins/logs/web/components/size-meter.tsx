import type { ReactElement } from "react";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { LogEntry } from "../../shared/resources";
import {
  formatBytes,
  formatSpan,
  liveFile,
  rotatedFiles,
  rotatesIn,
} from "../internal/present";

/** Soon enough to say so: a rotation within this window is shown in the row. */
const SOON_MS = 12 * 60 * 60 * 1000;

/**
 * The live file against its rotation bound — a bar, `live / max`, one pip per
 * kept rotation (filled when that file exists) — and, when it is close, how
 * long until it rotates. A log no sink bounds here says so instead.
 */
export function SizeMeter({
  entry,
  now,
}: {
  entry: LogEntry;
  now: number;
}): ReactElement {
  const live = liveFile(entry);
  const liveBytes = live?.bytes ?? 0;
  if (entry.bound === null) {
    return (
      <Text variant="caption" tone="muted">
        {formatBytes(liveBytes)} · rotated by the gateway
      </Text>
    );
  }
  const { maxBytes, keep } = entry.bound;
  const pct = Math.min(100, (liveBytes / maxBytes) * 100);
  const rotated = rotatedFiles(entry).length;
  const soon = rotatesIn(entry, now);
  const hot = pct > 85 || (soon !== null && soon < SOON_MS);
  return (
    <Stack gap="2xs">
      <Clip
        className="h-1.5 w-full rounded-full bg-muted"
        title={`${formatBytes(liveBytes)} of ${formatBytes(maxBytes)} in the live file · ${rotated} of ${keep} rotated files kept`}
      >
        <div
          className={cn(
            "h-full rounded-full",
            hot ? "bg-warning" : "bg-primary",
          )}
          style={{ width: `${liveBytes > 0 ? Math.max(pct, 1.5) : 0}%` }}
        />
      </Clip>
      <Stack direction="row" gap="xs" justify="between" align="center">
        <Text variant="caption" tone="muted">
          {formatBytes(liveBytes)} / {formatBytes(maxBytes)}
        </Text>
        <Stack direction="row" gap="2xs" align="center">
          {Array.from({ length: keep }, (_, i) => (
            <span
              key={i}
              className={cn(
                "size-1.5 rounded-xs border border-muted-foreground",
                i < rotated && "bg-muted-foreground",
              )}
            />
          ))}
        </Stack>
      </Stack>
      {soon !== null && soon < SOON_MS && (
        <Text variant="caption" tone="destructive">
          rotates in ~{formatSpan(soon)}
        </Text>
      )}
    </Stack>
  );
}
