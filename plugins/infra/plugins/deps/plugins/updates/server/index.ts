import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { TaskCategory } from "@plugins/tasks/plugins/task-category/server";
import { automationConfigRegistration } from "@plugins/tasks/plugins/automations/server";
import { depsUpgradesConfig } from "../shared/config";
import {
  DEPS_CATEGORY_ID,
  depsUpgradesAutomation,
} from "./internal/detect-job";

export {
  DEPS_CATEGORY_ID,
  UpdaterDeclare,
  declaredUpdaters,
} from "./internal/detect-job";

export default {
  description:
    "The updater registry (UpdaterDeclare) and the Dependency upgrades automation (deps-upgrades; its job automation.deps-upgrades runs on the schedule its config sets — weekly by default — editable live from the Automations pane): when any included updater has something newer than its lock records and no upgrade task is open, files ONE auto-started task (Dependencies category) covering every outdated updater, whose agent runs `./singularity deps upgrade` (all updaters behind one baseline, a regressed batch narrowed down to its culprits on its own) and pushes what landed on an `upgraded` or `partial` verdict as far as its Push setting allows.",
  contributions: [
    automationConfigRegistration(depsUpgradesConfig),
    TaskCategory({ id: DEPS_CATEGORY_ID, label: "Dependencies", order: 6 }),
  ],
  register: [depsUpgradesAutomation],
} satisfies ServerPluginDefinition;
