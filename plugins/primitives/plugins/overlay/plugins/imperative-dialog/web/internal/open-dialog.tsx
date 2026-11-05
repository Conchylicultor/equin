import { useCallback, type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  useRenderOrigin,
  type Raised,
} from "@plugins/primitives/plugins/scope/plugins/render-origin/web";

/** Presentation options forwarded to the dialog's `DialogContent`. */
export interface DialogOptions {
  size?: "sm" | "md" | "lg";
  className?: string;
  /**
   * Whether a press outside the panel closes the dialog. Default `true` — a
   * modal the user can leave the way they expect to.
   *
   * Set `false` for the one case where that is wrong: a dialog holding text the
   * user typed and has not committed (a password, a form being filled). Closing
   * such a dialog by a stray click throws the typing away with no warning, so
   * those ask for Cancel or Escape instead. It is NOT for merely important
   * dialogs — a destructive confirm holds nothing the user would lose, so it
   * stays dismissible.
   */
  dismissible?: boolean;
}

/**
 * Opens a modal dialog: `render` receives a `close` callback to dismiss it
 * from inside its content; the promise resolves once it closes (via `close`,
 * Escape, or a press outside the panel — unless `dismissible: false`), or once
 * the origin it was opened in goes away.
 */
export type OpenDialog = (
  render: (close: () => void) => ReactNode,
  options?: DialogOptions,
) => Promise<void>;

/**
 * The dialog opener of this caller: the returned function mounts a modal
 * `Dialog` from any callback (no JSX host, no `open` state), RENDERED IN THE
 * CALLER'S RENDER ORIGIN (`scope/render-origin`) — so the dialog's content
 * reads the caller's transport, plugin registry and navigator. A dialog
 * opened inside the demo writes to the demo's server, never the page's.
 * Stable per origin.
 */
export function useOpenDialog(): OpenDialog {
  const origin = useRenderOrigin();
  return useCallback<OpenDialog>(
    (render, options) =>
      new Promise<void>((resolve) => {
        let raised: Raised | null = null;
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const close = () => {
          raised?.remove();
          settle();
        };
        raised = origin.raise(
          <ImperativeDialog options={options} onClose={close}>
            {render(close)}
          </ImperativeDialog>,
          { onGone: settle },
        );
      }),
    [origin],
  );
}

/**
 * One open imperative dialog. `dismissible` is the one option that belongs on
 * the ROOT rather than on the panel — base-ui decides the outside press, so it
 * is split off here and the rest of the options spread onto `DialogContent`
 * as presentation. `DialogContent` portals to the page (or the nearest
 * `PortalHost`) and carries the origin's theme scope.
 */
function ImperativeDialog({
  options,
  onClose,
  children,
}: {
  options: DialogOptions | undefined;
  onClose: () => void;
  children: ReactNode;
}): ReactNode {
  const { dismissible = true, ...content } = options ?? {};
  return (
    <Dialog
      open
      disablePointerDismissal={!dismissible}
      onOpenChange={(open: boolean) => {
        if (!open) onClose();
      }}
    >
      <DialogContent {...content}>{children}</DialogContent>
    </Dialog>
  );
}
