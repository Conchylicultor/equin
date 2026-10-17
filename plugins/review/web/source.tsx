import { ToggleChip } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import type { Push } from "@plugins/tasks/plugins/tasks-core/core";

export type Source = { kind: "working" } | { kind: "push"; pushId: string };

export interface ReviewProps extends Record<string, unknown> {
  conversationId: string;
  source: Source;
}

export interface PushGroup {
  pushId: string;
  message: string;
  count: number;
  createdAt: Date;
}

export function groupPushes(rows: Push[]): PushGroup[] {
  const byId = new Map<string, PushGroup>();
  for (const row of rows) {
    const existing = byId.get(row.pushId);
    const createdAt = new Date(row.createdAt);
    if (existing) {
      existing.count += 1;
      if (createdAt > existing.createdAt) {
        existing.createdAt = createdAt;
        existing.message = row.message;
      }
    } else {
      byId.set(row.pushId, {
        pushId: row.pushId,
        message: row.message,
        count: 1,
        createdAt,
      });
    }
  }
  return [...byId.values()].sort((a, b) => +b.createdAt - +a.createdAt);
}

function formatDate(value: Date): string {
  return value.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function SourceTabs({
  source,
  onChange,
  pushGroups,
}: {
  source: Source;
  onChange: (next: Source) => void;
  /** One tab per push; `"pending"` while the attempt's pushes are not known. */
  pushGroups: PushGroup[] | "pending";
}) {
  return (
    <Scroll
      axis="x"
      className="border-b border-border bg-background/95 px-sm py-xs backdrop-blur"
    >
      <Stack direction="row" gap="xs" align="center">
        <ToggleChip
          active={source.kind === "working"}
          onClick={() => onChange({ kind: "working" })}
          tooltip="Uncommitted changes vs. main"
        >
          Working tree
        </ToggleChip>
        {pushGroups === "pending" ? (
          <Loading variant="spinner" />
        ) : (
          pushGroups.map((g) => (
            <ToggleChip
              key={g.pushId}
              active={source.kind === "push" && source.pushId === g.pushId}
              onClick={() => onChange({ kind: "push", pushId: g.pushId })}
              tooltip={`${g.message} · ${formatDate(g.createdAt)}`}
            >
              <span className="max-w-[24ch] truncate">{g.message}</span>
              {g.count > 1 && (
                <span
                  // eslint-disable-next-line spacing/no-adhoc-spacing -- inline gap before count badge after truncated message
                  className="ml-1 text-muted-foreground tabular-nums"
                >
                  ×{g.count}
                </span>
              )}
            </ToggleChip>
          ))
        )}
      </Stack>
    </Scroll>
  );
}
