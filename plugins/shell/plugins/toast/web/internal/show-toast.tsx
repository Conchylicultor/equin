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
import { linkProps } from "@plugins/primitives/plugins/link-gesture/web";
import { DeveloperMark } from "@plugins/audience/plugins/developer-mark/web";
import type { ReactNode } from "react";
import type { Audience } from "@plugins/audience/core";
import type { ToastArgs } from "../../core";
import { trackToast, untrackToast } from "./live-toasts";
import { toastReachesReader } from "./reader-audience";

/**
 * Page-unique toast ids we mint ourselves, rather than taking sonner's return
 * value: the body carries the id, so we need it *before* the enqueue.
 *
 * It must never repeat. `Observer.create` merges by id against
 * `ToastState.toasts` (sonner 2.0.7, `dist/index.mjs:145`) — an array sonner
 * never prunes — so a reused id republishes, and thereby resurrects, a toast
 * that died minutes ago. A string is disjoint from sonner's own numeric
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

/**
 * A toast whose whole content the caller draws (a notification's own view),
 * shown for `duration` ms — `Infinity` keeps it until dismissed or acted on.
 * The host adds nothing around it: the content paints its own surface.
 */
export interface CustomToastArgs {
  /** The toast's content, handed the toast's own `dismiss` (a × of its own). */
  render: (toast: { dismiss: () => void }) => ReactNode;
  duration: number;
  /** Who it is for — a `developer` toast is shown only in Developer mode. */
  audience?: Audience;
}

/**
 * Fire a text toast. Backed by sonner's global imperative API — callable from
 * anywhere; if no `<ToasterHost/>` is mounted the enqueue simply has no renderer
 * (a silent no-op, never a throw). A toast declaring `audience: "developer"` is
 * dropped unless the reader is in Developer mode.
 *
 * Data only — strings, and the caller's own closures (an `onClick`, a
 * `LinkTarget` its hooks built) — so it renders the same wherever the stack
 * is. A toast whose content is drawn by the caller (a component, with hooks)
 * is `useShowCustomToast`, which renders it in the caller's origin.
 */
export function showToast(args: ToastArgs): void {
  // A developer toast is shown only to a developer (Developer mode on).
  if (!toastReachesReader(args.audience)) return;
  showTextToast(nextToastId(), args);
}

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
      showCustomToast(origin, nextToastId(), args);
    },
    [origin],
  );
}

function showCustomToast(
  origin: RenderOriginHandle,
  id: string,
  { render, duration }: CustomToastArgs,
) {
  const dismiss = () => {
    sonnerToast.dismiss(id);
  };
  // The content renders in the caller's origin, portalled into an element of
  // its own; the toast's `<li>` adopts that element once the content has
  // committed (`raised.mounted`). Adopting rather than portalling into the
  // `<li>` from its own mount: sonner measures the toast's height in its
  // first effect, so the content must already be there when sonner mounts it.
  // React events still bubble through the origin's tree (a portal), and the
  // CSS — the chrome's theme, sonner's styles — is the `<li>`'s, by the DOM.
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
  const body = (
    <ToastBody id={id} onGone={raised.remove}>
      <AdoptElement
        element={element}
        onPortalContainer={(portal) => raised.update(contentIn(portal))}
      />
    </ToastBody>
  );
  // After the content committed, and through the same one-microtask
  // deferral as the text toast — see `showTextToast`.
  void raised.mounted.then(() =>
    queueMicrotask(() => sonnerToast.custom(() => body, { id, duration })),
  );
}

/**
 * Puts an element rendered elsewhere into this spot, in the layout phase, and
 * hands back the portal container this spot is drawn under.
 */
function AdoptElement({
  element,
  onPortalContainer,
}: {
  element: HTMLElement;
  onPortalContainer: (portal: HTMLElement | null | undefined) => void;
}) {
  const adopt = useCallback(
    (span: HTMLSpanElement | null) => {
      if (span !== null && element.parentNode !== span) span.append(element);
    },
    [element],
  );
  const portal = usePortalContainer();
  const report = useEventCallback(onPortalContainer);
  useLayoutEffect(() => report(portal), [portal, report]);
  return <span ref={adopt} style={{ display: "contents" }} />;
}

function showTextToast(
  id: string,
  { title, description, variant, audience, action }: ToastArgs,
): void {
  // `||`, not `??`: `title: ""` is a caller saying "no title", and `??` would
  // render an empty headline and drop the description entirely.
  const rawMessage = title || description;
  const rawDescription = title ? description : undefined;
  const fn = variant && variant !== "default" ? sonnerToast[variant] : sonnerToast;

  // Built eagerly, outside the microtask below, so the element snapshots the
  // caller's strings and any JSX error surfaces on the caller's own stack.
  //
  // Registered in the title slot ONLY. Sonner renders `toast.title` in the
  // `[data-title]` div unconditionally (2.0.7, `dist:794-797`) but the
  // description div only when a description is present — so a second
  // registration there would put two mounts behind one Set entry, and the
  // first unmount would untrack a toast the other half still shows.
  const body = (
    <ToastBody id={id}>
      <ContentScope fill={false}>
        {rawMessage}
        {/* The developer mark after the headline, inline so a long headline
            still wraps — the same mark the bell's row draws for it. */}
        {audience === "developer" && (
          <>
            {" "}
            <DeveloperMark />
          </>
        )}
      </ContentScope>
    </ToastBody>
  );

  // Deferred by exactly one microtask, never published inline. `Observer.publish`
  // (2.0.7, `dist:132`) is a synchronous `forEach` over the current subscribers
  // with no buffer and no replay, and the `<Toaster>`'s only subscription is
  // keyed on its own toast list (`dist:956-993`) — so it unsubscribes and
  // re-subscribes on every add and removal, and each such commit has a
  // synchronous stretch with zero subscribers. A producer calling us from a
  // `useEffect` lands in exactly that stretch and its toast is dropped on the
  // floor. A microtask checkpoint only occurs at stack-empty, and React's
  // passive flush (destroys, then creates) is one synchronous call, so a
  // microtask-deferred publish always lands after the Toaster is back.
  //
  // This does NOT cover a producer calling us from render or a layout effect —
  // no such caller exists today.
  queueMicrotask(() =>
    fn(body, {
      id,
      description: rawDescription ? <ContentScope fill={false}>{rawDescription}</ContentScope> : undefined,
      // Sonner renders + dismisses the action button itself; the caller only
      // supplies the intent (e.g. Undo). No bookkeeping here — the dismiss
      // unmounts the body, which retires the ledger entry. Called through a
      // wrapper because sonner passes the click event and `ToastArgs` promises
      // a nullary handler: forwarding it would hand the event to a caller whose
      // first parameter is its own optional argument.
      // A link action reads the click's modifiers (⌘/Ctrl → a new browser tab).
      action: action
        ? {
            label: action.label,
            onClick:
              "link" in action
                ? (e) => linkProps(action.link).onClick(e)
                : () => action.onClick(),
          }
        : undefined,
    }),
  );
}
