import {
  asNamespace,
  namespaceUrl,
} from "@plugins/infra/plugins/namespace/core";
import type { ReportRow } from "@plugins/reports/server";
import { LiveStateStaleDropPayloadSchema } from "../../core";
import type { LiveStateStaleDropPayload } from "../../core";

// Notification re-arm window: a still-wedged resource keeps dropping bodies on
// every retry, so this resurfaces occasionally (every 6h) rather than
// once-forever — same policy as optimistic-divergence / render-loop. Lives here
// (not the barrel) per barrel-purity.
export const LIVE_STATE_STALE_DROP_NOTIF_COOLDOWN_MS = 6 * 60 * 60 * 1000;

function payloadOf(row: ReportRow): LiveStateStaleDropPayload {
  // The row's data was validated by LiveStateStaleDropPayloadSchema at ingest,
  // so this is a total parse; failure would be a corrupted row (surfaced
  // loudly).
  return LiveStateStaleDropPayloadSchema.parse(row.data);
}

export function renderLiveStateStaleDropTask(row: ReportRow): {
  title: string;
  description: string;
} {
  return { title: renderTitle(row), description: renderDescription(row) };
}

function renderTitle(row: ReportRow): string {
  const data = payloadOf(row);
  const noisePrefix = row.noise ? "[noise] " : "";
  const raw = `${noisePrefix}[live-state-stale-drop] ${data.key} — ${data.consecutiveDrops} consecutive stale drops (${data.reason})`;
  return raw.length > 120 ? `${raw.slice(0, 117)}...` : raw;
}

function renderDescription(row: ReportRow): string {
  const data = payloadOf(row);
  const lines: string[] = [];

  lines.push(
    `A live-state HTTP fetch for \`${data.key}\` **dropped the body its guard judged stale**, and the query is **still holding only its placeholder** (\`neverApplied: ${data.neverApplied}\`) — the "Close (state unknown)" wedge. \`fetchOverHttp\` fetched the resource, the version/epoch guard rejected the body as \`${data.reason}\`, and because the query has never been settled by a server-vouched value it stays \`pending\` (a \`ResourceStaleReadError\` is thrown rather than the placeholder being returned). ${data.consecutiveDrops} consecutive drops have now fired for this key without an intervening apply.`,
  );
  lines.push("");
  lines.push(`**What it means**`);
  lines.push(
    data.reason === "stale-version"
      ? `Same-boot strict-\`<\` guard: the body's \`version\` (${data.bodyVersion}) was below the version the client already held (${data.haveVersion}). Within one boot this is a legitimate race (an invalidate bumped the entry past a GET that returned the older number) and heals on retry — a *repeating* row here means the retry keeps losing, i.e. the resource never flushes the newer version the client expects.`
      : `Cross-boot epoch guard (case 3): the body's boot epoch was the *stale* one relative to the WS channel's current server identity. Post-restart this should be a transient that heals once the socket re-subscribes; a *repeating* row means the client entry's epoch is stuck ahead of what the server vouches for, or the browser HTTP cache is still replaying an old-boot body (check \`Cache-Control: no-store\`).`,
  );
  lines.push("");
  lines.push(`**How to investigate**`);
  lines.push(
    `1. Read the trace: the \`live-state\` log channel of worktree \`${row.worktree}\` (\`logs/live-state.jsonl\` under its log dir — see \`plugins/debug/plugins/logs/CLAUDE.md\`), grepping for \`drop reason=${data.reason}\` lines for key \`${data.key}\` — each drop emits one. A repeating same-key loop (not a transient burst that stops) is the wedge.`,
  );
  lines.push(
    `2. Compare the epochs in this report: body \`${data.bodyEpoch ?? "null"}\`, entry \`${data.entryEpoch ?? "null"}\`, server \`${data.serverEpoch ?? "null"}\`. If the body epoch equals neither entry nor server, the guard's "no arbiter" branch should have *adopted* it — a drop here would be a guard-matrix bug.`,
  );
  lines.push(
    // eslint-disable-next-line endpoints/no-raw-endpoint-call -- a curl line in the task prompt, never fetched here
    `3. Verify the endpoint forbids shared/browser caching: \`curl -is '${namespaceUrl(asNamespace(row.worktree), `/api/resources/${data.key}`)}?...'\` must show \`Cache-Control: no-store\` on both the 200 and any 304. A missing header lets the browser HTTP cache replay an old-boot body revalidated via a restart-stable ETag — the original poisoning bug.`,
  );
  lines.push(
    `4. Read \`research/2026-07-15-global-live-state-http-cache-poisoning-class-fix.md\` for the full diagnosis, the epoch-aware guard matrix, and the never-applied escape hatch.`,
  );
  lines.push("");
  lines.push(`**Drop**`);
  lines.push(`- **Key:** \`${data.key}\``);
  if (Object.keys(data.params).length > 0) {
    const params = Object.entries(data.params)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    lines.push(`- **Params:** \`${params}\``);
  }
  lines.push(`- **Reason:** \`${data.reason}\``);
  lines.push(`- **Source:** \`${data.source}\``);
  lines.push(`- **Never applied:** ${data.neverApplied}`);
  lines.push(
    `- **Versions:** body ${data.bodyVersion}, have ${data.haveVersion}`,
  );
  lines.push(
    `- **Epochs:** body \`${data.bodyEpoch ?? "null"}\`, entry \`${data.entryEpoch ?? "null"}\`, server \`${data.serverEpoch ?? "null"}\``,
  );
  lines.push(
    `- **Consecutive drops:** ${data.consecutiveDrops} since the last apply`,
  );
  lines.push("");
  lines.push(`**Report**`);
  lines.push(`- **Source:** ${row.source}`);
  lines.push(`- **Worktree:** ${row.worktree}`);
  lines.push(`- **Fingerprint:** ${row.fingerprint}`);
  lines.push(`- **Count:** ${row.count}`);
  lines.push(`- **First seen:** ${row.firstSeenAt.toISOString()}`);
  lines.push(`- **Last seen:** ${row.lastSeenAt.toISOString()}`);
  if (row.url) lines.push(`- **URL:** ${row.url}`);
  if (row.userAgent) lines.push(`- **User-Agent:** ${row.userAgent}`);
  return lines.join("\n");
}
