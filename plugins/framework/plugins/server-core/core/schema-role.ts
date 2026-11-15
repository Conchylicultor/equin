import type { BootMode } from "./boot-mode";

// ── Who owns this database's schema ──────────────────────────────────────────
//
// Exactly one kind of process sets a database's schema up: the one that serves
// it (`serve`, and a `browser` host, which is the only process on its PGlite).
// An `exec` child — a supervised job's body, ~800 a day on main — boots out of
// the same checkout while the serving backend is live, so a child that ran the
// boot DDL itself (migrations, triggers, views, the job queue's schema) waited
// on the serving backend's locks, held the schema-layer lock main's own boot
// then waited behind, and — in the ~26 s after a push advanced the checkout
// and before the new backend booted — applied the push's migration under the
// old backend's feet (task-1794734803-m7admg, user decision D0 = A).
//
// So the boot mode decides it, once, and every boot hook is handed the answer
// (`BootHookContext.schema`): an owner gets a `SchemaOwner` token, a verifier
// gets none. The DDL chokepoints take the token as a REQUIRED argument
// (`DatabaseDriver.bootDdl`, a committing `applySchemaLayer`, the job queue's
// `install`), so a hook running in a child has nothing to pass them — "an
// exec child runs boot DDL" does not type-check. A verifier checks instead that
// the owner already set the schema up for its code, and refuses to run on a
// database that does not match it (database's `onReadyBlocking`).

declare const SCHEMA_OWNER: unique symbol;

/**
 * Proof that this process owns its database's schema. Only the boot sequence
 * mints one (`schemaRoleFor`, not on the barrel), for a serving host.
 */
export interface SchemaOwner {
  readonly [SCHEMA_OWNER]: true;
}

/** What a boot hook may do to its database's schema. */
export type SchemaRole =
  /** The serving host: sets the schema up (migrations, derived layer, triggers). */
  | { readonly kind: "owner"; readonly owner: SchemaOwner }
  /** An `exec` child: verifies the owner set it up for this code, never changes it. */
  | { readonly kind: "verifier" };

const OWNER = Object.freeze({}) as unknown as SchemaOwner;

/** The schema role of a process booted in `mode`. Boot sequence only. */
export function schemaRoleFor(mode: BootMode): SchemaRole {
  switch (mode) {
    case "serve":
    case "browser":
      return { kind: "owner", owner: OWNER };
    case "exec":
      return { kind: "verifier" };
  }
}

/**
 * A verifier found its database not set up for its code: the owner has not
 * (yet) committed this code's schema layer — a push advanced the checkout and
 * the serving backend has not rebooted on it, or the database was never booted
 * by this code — and stayed so for as long as the verifier waited for it
 * (database's `awaitSchemaLayer`). Not a fault of the work: a supervised child
 * exits `SUPERVISED_EXIT_SCHEMA_NOT_READY`, which a waiter that can re-ask
 * (a launch's `worktree.prepare` waiter) treats as back-pressure, and the
 * built-in ledger names in its failure.
 */
export class SchemaNotReadyError extends Error {
  constructor(readonly detail: string) {
    super(
      `[schema] this process's code does not match its database's schema, and only the serving backend sets the schema up: ${detail}`,
    );
    this.name = "SchemaNotReadyError";
  }
}
