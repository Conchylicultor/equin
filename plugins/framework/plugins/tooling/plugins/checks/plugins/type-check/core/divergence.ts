import { z } from "zod";

/**
 * The `type-check-divergence` report kind's name and payload, in `core` so both
 * filers share them: the backstop job (a file whose two-program result a full
 * check disagrees with) and every check run (a name the affected set predicted
 * stable that moved). The kind itself is registered by the backstop's server.
 */
export const TYPE_CHECK_DIVERGENCE_KIND = "type-check-divergence";

export const TypeCheckDivergencePayloadSchema = z.discriminatedUnion("kind", [
  z.object({
    /** What differed: its diagnostics, its signature, or whether it was checked at all. */
    kind: z.enum(["diagnostics", "signature", "missing"]),
    /** The repo-relative file whose two-program result differed. */
    file: z.string(),
    /** The two-program check's side (`keyed`, its historical name), and the full check's. */
    keyed: z.string(),
    full: z.string(),
    /** The main commit the backstop checked. */
    head: z.string(),
  }),
  z.object({
    /**
     * A check run's program 2 found `name` of `file` moved, and the affected
     * set had predicted it stable: what uses it was not going to be
     * re-checked. That run fell back to one whole program, so its verdict was
     * right; the affected set is what must be widened.
     */
    kind: z.literal("prediction"),
    file: z.string(),
    name: z.string(),
    /** The commit the run's checkout was on (its tree may have had edits). */
    head: z.string(),
  }),
]);

export type TypeCheckDivergencePayload = z.infer<
  typeof TypeCheckDivergencePayloadSchema
>;
