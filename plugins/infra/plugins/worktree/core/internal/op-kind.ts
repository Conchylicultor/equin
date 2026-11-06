// The closed set of ops a worktree runs that hold a live marker and land a
// durable op-log record: build, push, check, test, e2e, script. Every kind but
// `script` also takes a host grant (op-runtime's `OP_POOL`) and reads as the
// conversation working (`readsAsWorking` below).
//
// Declared ONCE, as data, here in the worktree plugin's web-safe core — the
// marker primitive (`worktree/server`) is where the vocabulary originates, and
// op-log, the op-status banner + chip, the Ops Gantt and the broadcasts panel all
// borrow it rather than restating it. Before this file the same union was spelled
// in seven places; adding a kind was a scavenger hunt, and a place that was
// missed simply mis-rendered the new kind. Now every per-kind map downstream is a
// `Record<OpKind, …>`, so adding a kind here and forgetting it there is a type
// error rather than a blank icon.
//
// Per-kind PRESENTATION data lives here too (the noun and the busy verb), because
// both runtimes phrase the same op: the CLI names it in a broadcast, the banner
// names it in a sentence. Icons do not — they are React components, and this
// barrel must stay importable without react; the chip keeps its own
// `Record<OpKind, IconType>`, which the type checker holds complete.

export interface OpKindMeta {
  /** The noun: "Build" → "Build in progress", "Build queued — waiting for lock". */
  label: string;
  /** The busy verb on a compact row: "Building". */
  progressive: string;
  /**
   * Whether an in-flight op of this kind stands for its conversation's pending
   * WORK — the op-status banner above the prompt, the sidebar chip, and what a
   * bare `./equin await` (no kinds named) waits on. False for a
   * plain script run: it can be a watcher or a dev server that never ends, and
   * a conversation must not read "working" for as long as one lives. It is
   * still an op everywhere else (the op log, the Ops views, machine-usage).
   */
  readsAsWorking: boolean;
}

export const OP_KINDS = {
  build: { label: "Build", progressive: "Building", readsAsWorking: true },
  push: { label: "Push", progressive: "Pushing", readsAsWorking: true },
  check: { label: "Check", progressive: "Checking", readsAsWorking: true },
  test: { label: "Test", progressive: "Testing", readsAsWorking: true },
  e2e: { label: "E2E", progressive: "Running e2e", readsAsWorking: true },
  script: {
    label: "Script",
    progressive: "Running a script",
    readsAsWorking: false,
  },
} as const satisfies Record<string, OpKindMeta>;

export type OpKind = keyof typeof OP_KINDS;

/** The ids as a non-empty tuple, so `z.enum(OP_KIND_IDS)` types directly. */
export const OP_KIND_IDS = Object.keys(OP_KINDS) as [OpKind, ...OpKind[]];

/** Is this self-reported string (a marker file, an op-log line) a known kind? */
export function isOpKind(value: string): value is OpKind {
  return Object.hasOwn(OP_KINDS, value);
}
