import type { z } from "zod";

/**
 * One launch option's value contract — a frozen token BOTH runtimes import by
 * name. The web control, the wire payload, and the server apply all read `V`
 * from here, so a control and the value it persists cannot drift apart.
 */
export interface LaunchOptionDef<V> {
  /** Stable key: the wire field, the reorder entry id, the server apply lookup. */
  readonly id: string;
  /** Wire + draft value type. JSON-serializable by construction. */
  readonly schema: z.ZodType<V>;
  /**
   * Seed for a fresh draft card. An EXISTING task never reads this — the detail
   * surface binds to the task's own row (see `useTaskBinding`).
   */
  readonly defaultValue: V;
}

export function defineLaunchOption<V>(
  def: LaunchOptionDef<V>,
): LaunchOptionDef<V> {
  return Object.freeze(def);
}
