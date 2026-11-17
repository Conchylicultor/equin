import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useReloadReadiness } from "@plugins/primitives/plugins/dom/plugins/reload-readiness/web";
import { reachesAudience } from "@plugins/audience/core";
import { useAudience } from "@plugins/audience/web";
import { ForAudience } from "@plugins/audience/plugins/developer-mark/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { useTabUpdate, type TabUpdate } from "../hooks/use-tab-update";
import {
  updateAffordance,
  type UpdateAffordance,
} from "../internal/update-policy";
import {
  updateLabelFor,
  updateMessageFor,
  type ShownAffordance,
} from "../internal/update-copy";
import { retryLoad, updateNow } from "../internal/update-state";
import { BuildTray } from "./build-tray";

const refreshIcon = symbol("refresh");

/** The pill's affordance, from the one verdict and the page's holds. */
export function useUpdateAffordance(): {
  update: TabUpdate;
  affordance: UpdateAffordance;
} {
  const update = useTabUpdate();
  const readiness = useReloadReadiness();
  return { update, affordance: updateAffordance(update, readiness) };
}

/**
 * The one Update control. A newer build is an update, not a fault: the tab
 * reloads itself at a safe moment (`UpdatePolicyRoot`), and this says so the
 * whole time the update is pending — never only once it is late — and offers
 * it at once, in a NEUTRAL fill: nothing is wrong. Its tooltip names what holds
 * the update ("Update waits for: Playback") when a running process does.
 *
 * Plugins that failed to load with no update to explain them are a real bug
 * (reported by the loader): a developer sees it red, marked developer-only,
 * with the failed plugins named; a user sees the same neutral pill offering a
 * retry.
 *
 * A real `<button>` of its own — a sibling of the Builds popover trigger,
 * never nested inside it. The accessible name is the full message.
 */
export function UpdateButton({
  update,
  affordance,
}: {
  update: TabUpdate;
  affordance: UpdateAffordance;
}) {
  if (affordance.kind === "none") return null;
  if (affordance.kind === "fault") return <FaultPill affordance={affordance} />;
  const target =
    update.kind === "available" || update.kind === "required"
      ? update.target
      : null;
  return (
    <UpdatePill
      affordance={affordance}
      developer={false}
      onClick={() => updateNow(target)}
    />
  );
}

function FaultPill({ affordance }: { affordance: ShownAffordance }) {
  const user = useAudience();
  if (user.status === "error") throw user.error;
  if (user.status === "loading") return null;
  if (!reachesAudience("developer", user.data)) {
    return (
      <UpdatePill
        affordance={affordance}
        developer={false}
        onClick={retryLoad}
      />
    );
  }
  return (
    <ForAudience audience="developer" mark="badge">
      <UpdatePill affordance={affordance} developer onClick={retryLoad} />
    </ForAudience>
  );
}

function UpdatePill({
  affordance,
  developer,
  onClick,
}: {
  affordance: ShownAffordance;
  /** The developer's view of a fault: the red fill and the detail. */
  developer: boolean;
  onClick: () => void;
}) {
  const message = updateMessageFor(affordance, developer);
  return (
    <Button
      tooltip={message}
      aria-label={message}
      variant={developer ? "default" : "secondary"}
      className={cn(
        // A pill whose refresh glyph sits at its start: only the label end
        // takes the pill's extra room, and no border — the fill reaches the
        // pill's full height.
        "rounded-full pill-end border-0 gap-control-sm font-semibold",
        // The developer's fault is the solid destructive fill; the label is
        // that tone's light foreground with 18% of the tone mixed back in, in
        // oklab (an achromatic foreground has no hue for oklch to keep). The
        // RAW `--*-solid` vars, not the `--color-*` aliases: those resolve at
        // :root, outside the chrome's theme scope.
        developer &&
          "bg-destructive-solid text-[color:color-mix(in_oklab,var(--destructive-solid)_18%,var(--destructive-solid-foreground))] hover:bg-[color:color-mix(in_oklab,var(--destructive-solid)_88%,var(--destructive-solid-foreground))] hover:text-destructive-solid-foreground",
      )}
      onClick={onClick}
    >
      <Icon icon={refreshIcon} className="size-3.5" />
      {updateLabelFor(affordance)}
    </Button>
  );
}

/**
 * The collapsed floating bar's glance (`ActionBar.Glance`): the Build tray
 * holding only the Update pill, so a pending update stays visible while the
 * Build control is hidden. Nothing otherwise.
 */
export function UpdateGlance() {
  const { update, affordance } = useUpdateAffordance();
  if (affordance.kind === "none") return null;
  return (
    <BuildTray>
      <UpdateButton update={update} affordance={affordance} />
    </BuildTray>
  );
}
