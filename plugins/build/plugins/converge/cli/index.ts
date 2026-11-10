// Shared CLI machinery, not a command (no default export): the decision main's
// convergence run (`./equin build --allow-main --converge`) makes.
export { decideConvergence } from "./internal/decide";
export type { ConvergenceDecision } from "./internal/decide";
