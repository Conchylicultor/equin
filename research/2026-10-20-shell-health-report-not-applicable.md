# Health report: a "not applicable here" status

## Context

In the browser demo (a host without the computer), the Claude Code and Agent SDK
drift rows read `needsMachine` values, which resolve to `GateUnavailable`.
`HealthStatus` has only `ok | attention | critical | unknown`, so both verdicts
(`claudeCodeVerdict`, `cliDriftVerdict`) map it to `unknown` with the
"not available in this version" sentence — and `unknown` outranks `ok` in
`mergeHealth`, so the merged dot is grey ("2 checks can't be read right now")
although nothing is wrong. "Unreadable" and "does not apply here" are different
claims; the type cannot say the second.

## Design

One new arm of `HealthStatus`, not a new row kind (a row only learns it is
inapplicable from its read, at runtime):

```ts
| { state: "not-applicable"; summary: string }  // summary = why (the unavailable sentence)
```

- **Merge** (`core/merge.ts`): a not-applicable row is skipped — it neither
  ranks, counts, pends nor transitions. `HealthLevel` (what the dot can show) is
  unchanged, so the dot structurally cannot show it. `verdictOf` folds only the
  applicable rows; with every row inapplicable the verdict is "All systems
  normal" (same rule as zero rows).
- **Per-row level**: `levelOf` returns `RowLevel = HealthLevel | "not-applicable"`;
  tone maps for rows are keyed by `RowLevel` (summary muted), the merged dot's
  maps stay keyed by `HealthLevel`.
- **Sort**: not-applicable rows go last (after `ok`), ties by `order`.
- **Render**: the row stays visible (it tells the reader why the check is absent),
  drawn with a HOLLOW dot (`StatusDot`'s `ringClass` arm — already the
  vocabulary for "not live") and a muted summary. No new UI primitive, so no
  prototype needed.
- **Store**: `sameStatus` / `isPulsing` read `transitioning` through one helper
  so the new arm (no `transitioning`) narrows cleanly.
- **Contributors**: `claudeCodeVerdict` and `cliDriftVerdict` map
  `status === "unavailable"` → `{ state: "not-applicable", summary: result.message }`.
  No other row reads a needsMachine value today.

## Files

- `plugins/shell/plugins/health-report/core/{types,merge,merge.test}.ts`, `CLAUDE.md`
- `plugins/shell/plugins/health-report/web/{internal/tone.ts,internal/store.ts,components/health-row.tsx,components/health-dot.tsx}`, `web/__tests__/health-report.test.tsx`
- `plugins/infra/plugins/claude-cli/plugins/availability/web/internal/claude-code-health{,.test}.ts`
- `plugins/conversations/plugins/runtime-sdk/web/internal/cli-drift{,.test}.ts`

## Verification

- `./singularity test` on health-report, claude-cli/availability, runtime-sdk.
- `./singularity build` (type-check + lint).
