/** Whether the code a closure loads is still what was on disk at an instant (`closureChangedSince`). */
export type ClosureSince =
  | {
      kind: "unchanged";
      /** Every repo file the closure reaches (absolute). */
      files: ReadonlySet<string>;
    }
  | {
      kind: "changed";
      /** The first file (or package resolution entry) found changed. */
      path: string;
      /** Its inode change time, ms since the epoch. */
      changedAtMs: number;
    }
  | {
      kind: "unmeasurable";
      /** Why the closure cannot be walked (a computed load, an import that does not resolve). */
      reason: string;
    };
