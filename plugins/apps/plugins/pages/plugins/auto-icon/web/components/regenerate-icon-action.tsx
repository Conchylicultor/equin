import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { ControlPanel } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { regeneratePageIcon } from "../../shared/endpoints";

const syncIcon = symbol("sync");

/**
 * The page icon picker's "Regenerate" footer row: asks the server to re-pick the
 * page's emoji. The pick runs inside the request, so the row is pending exactly
 * while it is in flight; the new icon arrives through the page's live row, and a
 * failure surfaces through the endpoint's global error toast. The pick needs the
 * computer (`needsMachine`): under a transport without one the row renders
 * disabled, saying why.
 */
export function RegenerateIconAction({ pageId }: { pageId: string }) {
  const mutation = useEndpointMutation(regeneratePageIcon);

  if (mutation.kind === "unavailable") {
    // The reason is a visible line, not a `hint`: a disabled row takes no
    // pointer events, so a tooltip on it could never be hovered.
    return (
      <ControlPanel.Row
        disabled
        icon={<Icon icon={syncIcon} />}
        description={mutation.message}
      >
        Regenerate
      </ControlPanel.Row>
    );
  }

  const pending = mutation.isPending;
  return (
    // Not muted: it is the picker's action. `Remove` beside it is the muted
    // one, the way out.
    <ControlPanel.Row
      disabled={pending}
      icon={<Icon icon={syncIcon} />}
      trailing={pending ? <Loading variant="spinner" /> : undefined}
      onSelect={() => {
        mutation.mutate({ params: { pageId } });
      }}
    >
      {pending ? "Regenerating…" : "Regenerate"}
    </ControlPanel.Row>
  );
}
