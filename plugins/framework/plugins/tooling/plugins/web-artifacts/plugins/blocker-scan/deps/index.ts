// The blocker scan's dependency: uBlock Origin Lite's default-on rulesets,
// collected into infra/deps' registry through the `default` array (Debug →
// Dependencies, `./equin deps install blocker-rulesets`).
import { blockerRulesets } from "./internal/blocker-rulesets";

export {
  blockerRulesets,
  DEFAULT_RULESETS_FILE,
} from "./internal/blocker-rulesets";

export default [blockerRulesets];
