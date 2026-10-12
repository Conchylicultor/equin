import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { idChip } from "@plugins/active-data/plugins/id-chip/web";
import { attemptIdKind } from "@plugins/tasks/plugins/task-ids/core";
import { ATTEMPT_CHIP_SURFACES } from "../core";
import {
  AttemptChip,
  useAttemptReferent,
  useAttemptTarget,
} from "./components/attempt-chip";

export { AttemptChip };

export default {
  description:
    "Renders raw `att-<id>` strings inline as clickable chips named after the attempt's conversation, opening that conversation (the attempt pane when it has none), and presents the attempt id kind to the id registry. Models emit the bare id, no tag wrapping needed.",
  contributions: [
    ...idChip({
      presenter: {
        kind: attemptIdKind,
        useReferent: useAttemptReferent,
        useTarget: useAttemptTarget,
      },
      surfaces: ATTEMPT_CHIP_SURFACES,
      component: AttemptChip,
    }),
  ],
} satisfies PluginDefinition;
