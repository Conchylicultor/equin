import { watchConfig } from "@plugins/config_v2/server";
import { refreshJobSchedules } from "@plugins/infra/plugins/jobs/server";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { catalogChanged } from "./catalog-changed";
import { syncLaunchBatch } from "./launch-batch";
import { registeredAutomations, type RegisteredAutomation } from "./registry";
import { automationSettings } from "./settings";

/**
 * For the life of the process: when an automation's config changes, re-install
 * the job schedules (its cron is resolved from that config) and re-push the
 * catalog; a launch-kind automation is also woken — turned on (or given more
 * slots), it starts at once rather than at its next event. Run once every
 * plugin is ready — `watchConfig` needs the config registered and loaded.
 *
 * A launch-kind automation's batch follows its switch first (turned on opens
 * a new one, turned off closes it — `maxLaunches` counts within it), then it
 * is woken. Boot does the same once: what changed or settled while the
 * backend was down announced nothing, and a free slot would otherwise wait
 * for the next event.
 */
export function watchAutomationConfigs(): void {
  for (const registered of registeredAutomations()) {
    const { spec } = registered;
    watchConfig(spec.config, () => {
      refreshJobSchedules();
      catalogChanged();
      if (spec.kind === "launch") {
        void runTracked(`automation:${spec.id}:batch-sync`, () =>
          syncThenWake(registered),
        );
      }
    });
    if (spec.kind === "launch") {
      void runTracked(`automation:${spec.id}:batch-sync`, () =>
        syncThenWake(registered),
      );
    }
  }
}

async function syncThenWake({
  spec,
  wake,
}: RegisteredAutomation): Promise<void> {
  await syncLaunchBatch(spec.id, automationSettings(spec).enabled);
  catalogChanged();
  wake();
}
