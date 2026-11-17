import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { BuildTray } from "../../web/components/build-tray";
import { UpdateButton } from "../../web/components/update-button";

const AVAILABLE = { kind: "available", target: "exhibit" } as const;

/**
 * The Update pill in each state a user can meet it, each in the Build tray as
 * the action bar shows it: an update a process holds, a pending one, and the
 * neutral retry a user (not in Developer mode) sees for a failed load.
 */
export default function UpdatePillExhibit() {
  return (
    <Stack gap="md" align="start" className="p-md">
      <BuildTray>
        <UpdateButton
          update={AVAILABLE}
          affordance={{ kind: "waiting", waitsFor: ["Playback"] }}
        />
      </BuildTray>
      <BuildTray>
        <UpdateButton update={AVAILABLE} affordance={{ kind: "ready" }} />
      </BuildTray>
      <BuildTray>
        <UpdateButton
          update={{ kind: "fault", failedPaths: ["apps/plugins/example"] }}
          affordance={{ kind: "fault", failedPaths: ["apps/plugins/example"] }}
        />
      </BuildTray>
    </Stack>
  );
}
