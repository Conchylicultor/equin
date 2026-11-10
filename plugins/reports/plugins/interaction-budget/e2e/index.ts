/**
 * e2e barrel for interaction budgets: a budget script measures its scenario's
 * cases and hands them to `settleBudget`, which prints the verdict and — on
 * main's filing run — files the `interaction-budget` report or moves the
 * scenario's commit-range start. Importable as
 * `@plugins/reports/plugins/interaction-budget/e2e`.
 */
export { settleBudget } from "./internal/settle";
export type { BudgetRun, BudgetVerdict } from "./internal/settle";
