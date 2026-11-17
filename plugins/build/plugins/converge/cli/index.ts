// Shared CLI machinery, not a command (no default export): the decision main's
// convergence run (`./equin build --allow-main --converge`) makes, and the
// one build a pass of it runs.
export { decideConvergence } from "./internal/decide";
export type { ConvergenceDecision } from "./internal/decide";
export { convergenceBuild } from "./internal/plan";
export type { ConvergenceBuild } from "./internal/plan";
