// One build as the detector sees it: every step's duration and file calls,
// read off the build profile (`build-profile-<id>.json`) the build already
// writes. Structural on purpose — the profile's own type lives in the CLI's
// op-runtime, which `core/` may not import — and total: a span field written
// before it existed reads as "not known" (null), never as zero.

/** File calls per kind and where most went — `packages/timed-fs`'s summary. */
export interface StepFsCalls {
  stat: number;
  readdir: number;
  read: number;
  glob: number;
  total: number;
  top: { prefix: string; calls: number }[];
}

/** A build profile span, as written (older profiles lack the newer fields). */
export interface ProfileSpanLike {
  id: string;
  phase: string;
  label: string;
  startMs: number;
  durationMs: number;
  fs?: StepFsCalls;
  cached?: boolean;
  wait?: true;
}

export interface ProfileLike {
  spans: ProfileSpanLike[];
}

/** One step of one build. */
export interface StepSample {
  durationMs: number;
  /** Null when the profile predates counting, or the step's record had none. */
  fs: StepFsCalls | null;
}

/** One build: when it ran, whether it rebuilt anything, and its steps by id. */
export interface BuildSteps {
  buildId: string;
  /** Epoch ms the build started (its id's stamp). */
  at: number;
  /**
   * The build rebuilt no web artifact (`artifacts:build (0 stale)`): every
   * step did the same work as the last such build, so its file calls are
   * comparable with theirs. Null when the profile has no artifacts step.
   */
  rebuiltNothing: boolean | null;
  steps: Map<string, StepSample>;
}

/** The build's per-check spans (`check:type-check`). */
const CHECK_STEP_PREFIX = "check:";

// The artifacts step names what it rebuilt in its label — the one record of it.
const STALE_LABEL = /\((\d+) stale\)/;

/** The epoch-seconds stamp in a build id (`build-1794358461-i6m19p`). */
export function buildIdTime(buildId: string): number | null {
  const m = /^build-(\d{10})-/.exec(buildId);
  return m ? Number(m[1]) * 1000 : null;
}

/**
 * The waits of a profile written before spans said so (`wait` absent on every
 * span): the build lock, the host grant, Postgres, the DB fork, the duress
 * hold, and a backend or central adopting the deploy or booting. A profile
 * that marks its waits is read by its own marks only.
 */
const LEGACY_WAIT_SPANS: ReadonlySet<string> = new Set([
  "acquireBuildLock",
  "acquireHostGrant",
  "waitForPg",
  "waitForDatabase",
  "duressHold",
  "adoptDeploy",
  "restartBackend",
  "probeHealth",
  "adoptCentral",
  "restartCentral",
]);

/**
 * Read a profile into steps. Waits are not steps: their length is another
 * party's. A check answered from the cache did none of its work, so it is not
 * a step of this build either. A step id that repeats (one per composition
 * target) keeps its longest occurrence.
 */
export function readBuildSteps(
  buildId: string,
  at: number,
  profile: ProfileLike,
): BuildSteps {
  const steps = new Map<string, StepSample>();
  let rebuiltNothing: boolean | null = null;
  const marksWaits = profile.spans.some((s) => s.wait !== undefined);
  for (const span of profile.spans) {
    if (span.id === "artifacts:build") {
      const m = STALE_LABEL.exec(span.label);
      if (m) rebuiltNothing = Number(m[1]) === 0;
    }
    if (marksWaits ? span.wait === true : LEGACY_WAIT_SPANS.has(span.id))
      continue;
    // A cached check did none of its work; one whose record predates the
    // field (`cached` absent on a check span) cannot be told apart from it.
    if (span.cached === true) continue;
    if (span.cached === undefined && span.id.startsWith(CHECK_STEP_PREFIX))
      continue;
    const prev = steps.get(span.id);
    if (prev !== undefined && prev.durationMs >= span.durationMs) continue;
    steps.set(span.id, { durationMs: span.durationMs, fs: span.fs ?? null });
  }
  return { buildId, at, rebuiltNothing, steps };
}
