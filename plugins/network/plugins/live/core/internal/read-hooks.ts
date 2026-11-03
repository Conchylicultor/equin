// The hooks network/live's web barrel exports, each with what it is. The
// design rule is ONE read hook: a new way to read server data is an option
// `useLive` reads, never a hook beside it. `live:read-hooks` holds the barrel
// to this table, so a second read hook (a `useLiveRow` beside `useLive`) is
// a check failure until it is written here — where it reads as a breach of
// the rule, not as one more export.

/** What a hook network/live's web barrel exports is. */
type LiveWebHookKind =
  /** THE read of server data: a collection or a value, by its query. */
  | "read"
  /** The one event-handler read: one answer an `await` consumes, never rendered live. */
  | "event-read"
  /** A slot registry read (which presentations / resolvers are contributed) — no server data. */
  | "slot-registry"
  /**
   * The reader's clock, pinned — what a read is computed against (a clock
   * param's value, a clock field's `now`), re-pinned at its next boundary by
   * one timer. No server data: the read itself is still `useLive`.
   */
  | "clock";

/** Every `use*` value network/live's web barrel exports — `live:read-hooks` holds the barrel to it. */
export const LIVE_WEB_HOOKS = {
  useLive: "read",
  useLiveReader: "event-read",
  useFieldPresentations: "slot-registry",
  useClientFieldsResolvers: "slot-registry",
  useClockPin: "clock",
  useClockParam: "clock",
} as const satisfies Readonly<Record<string, LiveWebHookKind>>;
