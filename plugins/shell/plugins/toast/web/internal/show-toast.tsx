import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { toast as sonnerToast } from "sonner";
import { chromeThemeScope } from "@plugins/apps-core/plugins/chrome-theme/web";
import { Theme } from "@plugins/primitives/plugins/css/plugins/theme-boundary/web";
import {
  PortalContainerProvider,
  usePortalContainer,
} from "@plugins/primitives/plugins/overlay/plugins/portal-host/web";
import { useEventCallback } from "@plugins/primitives/plugins/latest-ref/web";
import {
  useRenderOrigin,
  type RenderOriginHandle,
} from "@plugins/primitives/plugins/scope/plugins/render-origin/web";
import { ContentScope } from "@plugins/primitives/plugins/select-scope/web";
import type { ReactNode } from "react";
import type { Audience } from "@plugins/audience/core";
import { trackToast, untrackToast } from "./live-toasts";
import { toastReachesReader } from "./reader-audience";
import { isPageOnScreen } from "./on-screen";

/**
 * Page-unique toast ids we mint ourselves, rather than taking sonner's return
 * value: the body carries the id, so we need it *before* the enqueue.
 *
 * It must never repeat. `Observer.create` merges by id against
 * `ToastState.toasts` — a history sonner keeps after a toast is dismissed,
 * trimmed of dismissed toasts only once it passes 100 (2.0.8,
 * `MAX_HISTORY_SIZE` / `trimHistory`) — so a reused id republishes, and
 * thereby resurrects, a toast that died minutes ago. The same history keeps
 * each of those last ~100 toasts' JSX alive — so a custom toast's JSX holds
 * its content only through a reference released when it is gone
 * (`showCustomToast`; `research/2026-11-11-global-browser-tab-memory.md`). A string is disjoint from sonner's own numeric
 * counter by construction, and the session prefix keeps an HMR reload (which
 * restarts `seq` under a still-live sonner module) from colliding with the
 * ids the previous module instance handed out.
 *
 * It must also never be falsy: `toastFunction` resolves `data?.id || counter++`
 * (`dist:374`), so an empty-string id would silently get a sonner id instead,
 * and the ledger — keyed by the id the body was given — would count a toast
 * that no dismiss can ever reach.
 */
const SESSION = Math.random().toString(36).slice(2, 8);
let seq = 0;

/** What counts as a control: a click inside one is never the toast's own. */
const CONTROL_SELECTOR =
  "button, a[href], input, select, textarea, [role='button'], [role='link']";

/** Whether `event` landed on a control inside the toast's `li`. */
function isControlClick(event: MouseEvent, li: HTMLElement): boolean {
  if (!(event.target instanceof Element)) return false;
  const control = event.target.closest(CONTROL_SELECTOR);
  return control !== null && li.contains(control);
}

/**
 * The part of a toast that we render, and therefore the plugin's one point of
 * contact with a toast that is actually on screen. It owns both on-screen
 * concerns: registering the toast in the live ledger for its whole mounted
 * lifetime, and making the enclosing sonner `<li>` dismiss on click.
 *
 * Registering here rather than at enqueue time is the ledger's whole invariant:
 * an enqueue sonner drops never mounts and so is never counted, and every exit
 * a toast has (timer, close button, swipe, action button, programmatic
 * dismiss, the host unmounting) converges on this one unmount — so none of
 * them needs enumerating.
 */
function ToastBody({
  id,
  onGone,
  children,
}: {
  id: string;
  /** Runs once the body has unmounted for good (not StrictMode's re-run). */
  onGone?: () => void;
  children: React.ReactNode;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);

  // Deliberately its own effect, separate from the click wiring below: that
  // one bails when the sonner `<li>` can't be found, and tracking must not
  // inherit that early return. Idempotent under StrictMode's
  // create → destroy → create because the ledger is a Set keyed by id.
  //
  // Assumes a single mounted `<ToasterHost/>` — two at once would each render
  // a body for the same id, and the first unmount would untrack a toast the
  // other host still shows. Not a supported configuration (`Core.Root` gives
  // one contribution per plugin), so it is noted rather than refcounted.
  useEffect(() => {
    trackToast(id);
    return () => untrackToast(id);
  }, [id]);

  // A custom toast's content lives in its caller's origin: it ends when the
  // body does. StrictMode's destroy → create re-mounts within the same task,
  // so the end is decided a microtask later.
  const mountsRef = useRef({ count: 0 });
  useEffect(() => {
    if (onGone === undefined) return;
    const mounts = mountsRef.current;
    const mount = ++mounts.count;
    return () => {
      queueMicrotask(() => {
        if (mounts.count === mount) onGone();
      });
    };
  }, [onGone]);

  // Dismiss the whole toast on click, while still allowing the user to select /
  // drag the text: a click that ends an active text selection is ignored. A
  // click on a control inside the toast (its action button, a custom toast's
  // ×, a popover trigger) is the control's own — it acts (and dismisses, if
  // it means to) itself. Checked here rather than by the control stopping
  // propagation: this listener is native on the `<li>`, below React's root
  // listener, so a React `stopPropagation` would come too late.
  useEffect(() => {
    const li = anchorRef.current?.closest<HTMLElement>("[data-sonner-toast]");
    if (!li) return;
    li.style.cursor = "pointer";
    const onClick = (event: MouseEvent) => {
      if (isControlClick(event, li)) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.toString().trim().length > 0) return;
      sonnerToast.dismiss(id);
    };
    li.addEventListener("click", onClick);
    return () => li.removeEventListener("click", onClick);
  }, [id]);

  return (
    <span ref={anchorRef} style={{ display: "contents" }}>
      {children}
    </span>
  );
}

/** How long an announcement is shown — every announcement, whatever its variant. */
export const ANNOUNCEMENT_DURATION_MS = 4000;

/**
 * A toast whose whole content the caller draws (a notification's own view).
 * The host adds nothing around it: the content paints its own surface.
 *
 * Why it is shown decides how long it stays, so the caller states the why,
 * never an announcement's duration:
 *
 * - `announcement` — something that happened on its own (a notification
 *   arriving). Raised only on a page on screen, and gone after
 *   `ANNOUNCEMENT_DURATION_MS` whatever it says: its record is its persistent
 *   surface (the bell's row and unread badge), so a tab left on screen never
 *   piles them up.
 * - `reply` — the answer to something the user just did (a failed save). Shown
 *   whatever the page's state, for `duration` ms; `Infinity` keeps it until
 *   dismissed or acted on.
 */
export type CustomToastArgs = {
  /** The toast's content, handed the toast's own `dismiss` (a × of its own). */
  render: (toast: { dismiss: () => void }) => ReactNode;
  /** Who it is for — a `developer` toast is shown only in Developer mode. */
  audience?: Audience;
} & ({ kind: "announcement" } | { kind: "reply"; duration: number });

function nextToastId(): string {
  return `shell-toast-${SESSION}-${++seq}`;
}

/**
 * The custom toast, bound to the caller's render origin: the caller's node IS
 * the toast (e.g. a notification's own view, so the toast and the bell's row
 * are one component), and it renders in the CALLER's tree — under its
 * transport, plugin registry and navigator (`scope/render-origin`) — while
 * the page's stack only places it. A toast raised inside the demo thus reads
 * and acts on the demo, never on the page's server.
 */
export function useShowCustomToast(): (args: CustomToastArgs) => void {
  const origin = useRenderOrigin();
  return useCallback(
    (args: CustomToastArgs) => {
      if (!toastReachesReader(args.audience)) return;
      // An announcement is for a user looking at the page (`isPageOnScreen`).
      if (args.kind === "announcement" && !isPageOnScreen()) return;
      showCustomToast(origin, nextToastId(), args);
    },
    [origin],
  );
}

function showCustomToast(
  origin: RenderOriginHandle,
  id: string,
  args: CustomToastArgs,
) {
  const duration =
    args.kind === "announcement" ? ANNOUNCEMENT_DURATION_MS : args.duration;
  let live: RaisedContent | null = raiseContent(origin, args.render, () => {
    sonnerToast.dismiss(id);
  });
  const { mounted } = live;
  // sonner keeps a dismissed toast's JSX in its history (its last ~100
  // toasts, `Observer.toasts`), so the JSX below reaches the heavy parts —
  // the adopted element (and through it the toast's detached `<li>`, the
  // content's DOM and listeners) — only through `live`, released once the
  // body is gone for good. Built in `raiseContent`, never here: closures of
  // one function share one scope, so a local here would be kept by every
  // closure the JSX holds. Before, each dismissed custom toast kept ~58 KB,
  // 7 DOM nodes and ~143 listeners alive until 100 later toasts pushed it out.
  const gone = () => {
    const held = live;
    live = null;
    held?.remove();
  };
  const body = (
    <ToastBody id={id} onGone={gone}>
      <AdoptElement
        adoptee={() => live?.element ?? null}
        onPortalContainer={(portal) => live?.update(portal)}
      />
    </ToastBody>
  );
  // After the content committed, then deferred by exactly one microtask,
  // never published inline. `Observer.publish` (sonner 2.0.7, `dist:132`) is a
  // synchronous `forEach` over the current subscribers with no buffer and no
  // replay, and the `<Toaster>`'s only subscription is keyed on its own toast
  // list (`dist:956-993`) — so it unsubscribes and re-subscribes on every add
  // and removal, and each such commit has a synchronous stretch with zero
  // subscribers. A publish from a `useEffect` lands in exactly that stretch and
  // its toast is dropped on the floor. A microtask checkpoint only occurs at
  // stack-empty, and React's passive flush (destroys, then creates) is one
  // synchronous call, so a microtask-deferred publish always lands after the
  // Toaster is back.
  void mounted.then(() =>
    queueMicrotask(() => sonnerToast.custom(() => body, { id, duration })),
  );
}

interface RaisedContent {
  /** The element the content portals into, for the toast's `<li>` to adopt. */
  element: HTMLElement;
  /** Re-render the content under the portal container the toast is drawn in. */
  update: (portal: HTMLElement | null | undefined) => void;
  remove: () => void;
  mounted: Promise<void>;
}

/**
 * The content renders in the caller's origin, portalled into an element of
 * its own; the toast's `<li>` adopts that element once the content has
 * committed (`mounted`). Adopting rather than portalling into the `<li>`
 * from its own mount: sonner measures the toast's height in its first
 * effect, so the content must already be there when sonner mounts it. React
 * events still bubble through the origin's tree (a portal), and the CSS — the
 * chrome's theme, sonner's styles — is the `<li>`'s, by the DOM.
 */
function raiseContent(
  origin: RenderOriginHandle,
  render: CustomToastArgs["render"],
  dismiss: () => void,
): RaisedContent {
  const element = document.createElement("div");
  element.style.display = "contents";
  const content = render({ dismiss });
  // What the toast layer provides its content besides the DOM: where a popup
  // opened from the toast draws (the layer's PortalHost, so a notification's
  // Fix popover paints above the toasts) and the chrome's theme scope.
  const contentIn = (portal: HTMLElement | null | undefined) =>
    createPortal(
      <PortalContainerProvider container={portal}>
        <Theme name={chromeThemeScope} surface="none" className="contents">
          <ContentScope fill={false}>{content}</ContentScope>
        </Theme>
      </PortalContainerProvider>,
      element,
    );
  const raised = origin.raise(contentIn(undefined), { onGone: dismiss });
  return {
    element,
    update: (portal) => raised.update(contentIn(portal)),
    remove: raised.remove,
    mounted: raised.mounted,
  };
}

/**
 * Puts an element rendered elsewhere into this spot, in the layout phase, and
 * hands back the portal container this spot is drawn under.
 */
function AdoptElement({
  adoptee,
  onPortalContainer,
}: {
  /** The element to adopt — `null` once the toast is gone for good. */
  adoptee: () => HTMLElement | null;
  onPortalContainer: (portal: HTMLElement | null | undefined) => void;
}) {
  const adopt = useCallback(
    (span: HTMLSpanElement | null) => {
      const element = adoptee();
      if (span !== null && element !== null && element.parentNode !== span)
        span.append(element);
    },
    [adoptee],
  );
  const portal = usePortalContainer();
  const report = useEventCallback(onPortalContainer);
  useLayoutEffect(() => report(portal), [portal, report]);
  return <span ref={adopt} style={{ display: "contents" }} />;
}
