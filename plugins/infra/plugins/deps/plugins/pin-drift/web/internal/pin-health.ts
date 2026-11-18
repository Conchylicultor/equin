import type {
  ResourceResult,
  ResourceUnavailable,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import type { HealthStatus } from "@plugins/shell/plugins/health-report/web";
import type { PinDrift, PinnedDepRow, PinnedInstallView } from "../../core";

/** An install as people read it: its version, else its identity. */
export function installLabel(install: PinnedInstallView): string {
  return install.version ?? install.identity;
}

/**
 * One pinned dependency's verdict: `ok` (nothing pinned yet — the next start
 * pins main's — or pinned to what main declares and running it), `attention`
 * with a phrase (main declares another version, switchable or blocked; or a
 * moved pin the live daemon has not restarted onto), or `unknown` (main's
 * declaration unreadable).
 */
export type PinVerdict =
  { level: "ok" } | { level: "attention" | "unknown"; phrase: string };

export function pinVerdict(row: PinnedDepRow): PinVerdict {
  const s = row.status;
  if (s.kind === "unpinned") return { level: "ok" };
  const pinned = installLabel(s.pinned);
  switch (s.declared.kind) {
    case "failed":
      return {
        level: "unknown",
        phrase: `${row.id}: couldn't read what main declares`,
      };
    case "differs": {
      const to = installLabel(s.declared.install);
      return {
        level: "attention",
        phrase:
          s.declared.blocked === null
            ? `${row.id} ${pinned} → ${to}`
            : `${row.id} ${pinned} → ${to} blocked`,
      };
    }
    case "same":
      return s.running === null
        ? { level: "ok" }
        : {
            level: "attention",
            phrase: `${row.id} still runs ${installLabel(s.running)}, pinned ${pinned}`,
          };
  }
}

/**
 * The Pinned binaries row's verdict: loading → `unknown` with no summary
 * (never `ok`); a host without the computer, a release or no pin →
 * `not-applicable`; otherwise the worst row's — `attention` naming each
 * dependency that lags main (or whose daemon lags its pin), `unknown` when
 * one cannot be compared, `ok` when every pin runs what main declares. The
 * switch command, a block's reason and when a move applies are the row's
 * expanded detail.
 */
export function pinDriftVerdict(
  result: ResourceResult<PinDrift> | ResourceUnavailable,
): HealthStatus {
  if (result.status === "unavailable") {
    return { state: "not-applicable", summary: result.message };
  }
  if (result.status === "loading") return { state: "unknown" };
  if (result.status === "error") {
    return {
      state: "unknown",
      summary: "Couldn't load the pinned binaries' status",
    };
  }
  const d = result.data;
  switch (d.kind) {
    case "not-applicable":
      return { state: "not-applicable", summary: d.reason };
    case "unreadable":
      return {
        state: "unknown",
        summary: `Couldn't compare the pinned binaries: ${d.message}`,
      };
    case "checked": {
      const verdicts = d.rows.map(pinVerdict);
      const phrases = verdicts.flatMap((v) =>
        v.level === "ok" ? [] : [v.phrase],
      );
      if (verdicts.some((v) => v.level === "attention")) {
        return {
          state: "attention",
          summary: phrases.join("; "),
          title: "Pinned binaries lag main",
        };
      }
      if (phrases.length > 0) {
        return { state: "unknown", summary: phrases.join("; ") };
      }
      return { state: "ok", summary: "Up to date with main" };
    }
  }
}
