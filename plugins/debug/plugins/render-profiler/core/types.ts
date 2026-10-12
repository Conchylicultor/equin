/** Inferred kind of a hook whose state changed (drove a re-render). */
export type HookKind =
  | "state"
  | "reducer"
  | "external-store"
  | "effect"
  | "layout-effect"
  | "memo"
  | "callback"
  | "ref"
  | "context"
  | "unknown";

/**
 * One hook in a component's hook-call order.
 * `index` is the position in the component's hook list (for context entries it
 * is the context-dependency position, kind "context"). `changed` is true when
 * the hook's memoized value differed from the previous commit.
 */
export interface HookChange {
  index: number;
  kind: HookKind;
  changed: boolean;
}

/** Aggregated stats for one initiator signature over a profiling session. */
export interface InitiatorStat {
  signature: string;
  componentName: string;
  /** Nearest few ancestor component display names, nearest-last. */
  ancestorPath: string[];
  /**
   * Number of distinct commits this initiator appeared in (≤ total commits).
   * This — not the raw fiber count — is the "ticks every ~1s" rate driver.
   */
  commitCount: number;
  /**
   * Number of fiber instances sharing this signature in the most recent commit
   * it appeared in. >1 means a repeated list row (e.g. 180 SortableItem rows all
   * re-rendering together); the row re-renders `commitCount`×, ×`instanceCount`
   * fibers each.
   */
  instanceCount: number;
  ratePerSec: number;
  firstSeenMs: number;
  lastSeenMs: number;
  changedHooks: HookChange[];
  /** Commits where this initiator's fiber freshly mounted (`alternate === null`). */
  mountCount: number;
  /** Commits where this initiator's fiber updated in place (`alternate !== null`). */
  updateCount: number;
  /**
   * Component fibers rendered under this initiator, summed over the session —
   * rate × size. A rare initiator re-rendering the whole tree outranks a
   * frequent one re-rendering itself.
   */
  fibersRendered: number;
}

/** One commit of the session, in order: when, how big, and who started it. */
export interface CommitSample {
  /** `performance.now()` at the commit. */
  atMs: number;
  /** Component fibers that rendered this commit. */
  rendered: number;
  /** The commit's initiators, largest render first: name and fibers rendered under it. */
  initiators: { name: string; rendered: number }[];
}

/**
 * Structural reason a position was destroyed-and-rebuilt rather than updated in
 * place. `element-type` = the rendered element type flipped (e.g. `Fragment→div`);
 * `key-change` = same type but a different React `key`; `unknown` reserved.
 */
export type RemountCause = "element-type" | "key-change" | "unknown";

/** Aggregated stats for one remounting reconciliation position over a session. */
export interface RemountStat {
  /** key/index-keyed structural path identifying the reconciliation position. */
  positionKey: string;
  /** Nearest component ancestor display names, nearest-last (display). */
  ancestorPath: string[];
  /** Prev occupant name at this position. */
  fromType: string;
  /** Current occupant name at this position. */
  toType: string;
  cause: RemountCause;
  /** Number of commits in which this position remounted. */
  count: number;
}

/** The ranked snapshot the pane and headless callers read. */
export interface ProfilerReport {
  running: boolean;
  startedAtMs: number | null;
  durationMs: number;
  totalCommits: number;
  commitsPerSec: number;
  initiators: InitiatorStat[];
  /** Remounting positions ranked by count desc. */
  remounts: RemountStat[];
  /** Every commit in order (the first `COMMIT_LOG_CAP`; `commitLogTruncated` past it). */
  commits: CommitSample[];
  commitLogTruncated?: boolean;
  /** Set when the position map hit POSITION_MAP_CAP (some remounts may be missed). */
  remountTruncated?: boolean;
  /**
   * Set when the passive commit bridge (index.html) was not installed — e.g.
   * the frontend was not rebuilt after this feature landed. The engine cannot
   * receive commit callbacks; the pane surfaces this so the user runs a build.
   */
  bridgeMissing?: boolean;
}

export interface ProfilerStartOptions {
  /** Auto-stop after this many ms. Default 30000. */
  maxDurationMs?: number;
}
