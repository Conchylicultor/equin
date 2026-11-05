import { z } from "zod";

// Who issued an operation (the immediate enclosing request/loader span), before
// any per-occurrence counts are merged in — the identity the recorder folds
// into a `slow_op_callers` row. A SpanRef (server span parent) is structurally
// assignable to it; client signals supply { kind: "route", ... }.
export const CallerRefSchema = z.object({
  kind: z.string(),
  label: z.string(),
});
export type CallerRef = z.infer<typeof CallerRefSchema>;
