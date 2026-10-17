import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { useReloadAdvice, type ReloadAdvice } from "../hooks/use-reload-advice";
import { reloadIsFailing, reloadMessageFor } from "../internal/reload-copy";
import { BuildTray } from "./build-tray";

const refreshIcon = symbol("refresh");

/**
 * The one Reload control: shown when the tab is stale, cannot load some data
 * (outdated), or part of the app failed to load. A FILLED pill at the control
 * height — it is the one thing the bar asks the user to do, so it reads as a
 * button, not a status — in the SOLID fills: info when only stale, destructive
 * when something already fails. (The chrome theme deepens those to navy and
 * oxblood with white text; every other theme paints its own info/destructive.)
 *
 * The same component sits at the end of the Build tray when the bar is open and
 * alone in the tray when it is collapsed (`ReloadGlance`), so the two states
 * show one control.
 *
 * A real `<button>` of its own — a sibling of the Builds popover trigger, never
 * nested inside it — so pressing it reloads without opening the popover.
 *
 * The accessible name is the full message, not just "Reload": the fill is
 * otherwise the only difference between "out of date" and "broken", and the
 * tooltip is only there for a pointer.
 */
export function ReloadButton({ advice }: { advice: ReloadAdvice }) {
  if (advice.kind === "none") return null;
  const message = reloadMessageFor(advice);
  return (
    <Button
      tooltip={message}
      aria-label={message}
      className={cn(
        // A pill whose refresh glyph sits at its start: only the label end
        // takes the pill's extra room (10px | 12px), the glyph sits 6px from
        // the label, and no border — the fill reaches the pill's full height.
        "rounded-full pill-end border-0 gap-control-sm font-semibold",
        // The fill is the solid tone; the label is that tone's light
        // foreground with 18% of the tone mixed back in, so it reads as
        // tinted light rather than stark white. Hover lifts the fill 12%
        // toward the foreground and the label to the foreground itself.
        // Mixed in oklab, not oklch: an achromatic foreground (white) has no
        // hue of its own, and an oklch mix would swing the tint's hue toward
        // the foreground's nominal 0°. The RAW `--*-solid` vars, not the
        // `--color-*` aliases: those resolve at :root, outside the chrome's
        // theme scope.
        reloadIsFailing(advice)
          ? "bg-destructive-solid text-[color:color-mix(in_oklab,var(--destructive-solid)_18%,var(--destructive-solid-foreground))] hover:bg-[color:color-mix(in_oklab,var(--destructive-solid)_88%,var(--destructive-solid-foreground))] hover:text-destructive-solid-foreground"
          : "bg-info-solid text-[color:color-mix(in_oklab,var(--info-solid)_18%,var(--info-solid-foreground))] hover:bg-[color:color-mix(in_oklab,var(--info-solid)_88%,var(--info-solid-foreground))] hover:text-info-solid-foreground",
      )}
      onClick={() => window.location.reload()}
    >
      <Icon icon={refreshIcon} className="size-3.5" />
      Reload
    </Button>
  );
}

/**
 * The collapsed floating bar's glance (`ActionBar.Glance`): the Build tray
 * holding only the Reload pill, so a due reload stays visible while the Build
 * control is hidden. Renders nothing when no reload is due.
 */
export function ReloadGlance() {
  const advice = useReloadAdvice();
  if (advice.kind === "none") return null;
  return (
    <BuildTray>
      <ReloadButton advice={advice} />
    </BuildTray>
  );
}
