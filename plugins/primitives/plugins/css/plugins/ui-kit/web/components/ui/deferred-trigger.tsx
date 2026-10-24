"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { cloneElement, useLayoutEffect, useMemo, useState } from "react";
import type {
  HTMLAttributes,
  ReactElement,
  ReactNode,
  Ref,
  RefCallback,
  SyntheticEvent,
} from "react";
import { flushSync } from "react-dom";

/**
 * The props a base-ui trigger computes for its element (`render`'s first
 * argument): event handlers, state attributes and its merged `ref`.
 */
type TriggerProps = Record<string, unknown> & { ref?: Ref<Element> };

/**
 * Passed as the `render` of a base-ui trigger mounted by `mount`: it renders
 * nothing itself and hands the trigger's props to the deferred element.
 */
export type RenderDeferredTrigger = (
  props: HTMLAttributes<Element> & { ref?: Ref<Element> },
) => ReactElement;

/** The events that first show intent, replayed into the trigger once mounted. */
type IntentEvent = "onPointerEnter" | "onFocus";

/**
 * What of the trigger's props reaches the element through React: its
 * attributes by value, its handlers by name (each a stable delegate to the
 * latest handler, so a trigger render that only rebuilds handlers costs no
 * re-render of the element).
 */
interface Snapshot {
  attrs: Record<string, unknown>;
  handlers: readonly string[];
}

function snapshotOf(props: TriggerProps): Snapshot {
  const attrs: Record<string, unknown> = {};
  const handlers: string[] = [];
  for (const [key, value] of Object.entries(props)) {
    if (key === "ref") continue;
    if (typeof value === "function") handlers.push(key);
    else attrs[key] = value;
  }
  return { attrs, handlers: handlers.sort() };
}

function sameSnapshot(a: Snapshot | null, b: Snapshot): boolean {
  if (!a || a.handlers.join() !== b.handlers.join()) return false;
  const keys = Object.keys(b.attrs);
  return (
    keys.length === Object.keys(a.attrs).length &&
    keys.every((key) => Object.is(a.attrs[key], b.attrs[key]))
  );
}

/** Attaches `ref` to `node`; returns its detach (React 19 ref semantics). */
function attachRef(ref: Ref<Element> | undefined, node: Element): () => void {
  if (!ref) return () => {};
  if (typeof ref === "function") {
    const cleanup = ref(node);
    return typeof cleanup === "function" ? cleanup : () => void ref(null);
  }
  ref.current = node;
  return () => {
    ref.current = null;
  };
}

function elementRef(element: ReactElement): Ref<Element> | undefined {
  return (element.props as { ref?: Ref<Element> }).ref;
}

/**
 * One deferred element's imperative half: its DOM node, the trigger's latest
 * props, the trigger ref attached to that node, and an intent waiting to be
 * replayed. Lives for the component's lifetime (`useState`), touched only from
 * events, refs and effects — never read during render.
 */
class TriggerBridge {
  private node: Element | null = null;
  private latest: TriggerProps | null = null;
  private attached: {
    ref: Ref<Element>;
    node: Element;
    detach: () => void;
  } | null = null;
  private pending: { name: IntentEvent; event: SyntheticEvent } | null = null;

  constructor(
    private readonly arm: () => void,
    private readonly setSnapshot: (
      update: (prev: Snapshot | null) => Snapshot | null,
    ) => void,
  ) {}

  /** Keeps the trigger's ref attached to the element's current node. */
  private syncTriggerRef() {
    const ref = this.latest?.ref;
    const el = this.node;
    const current = this.attached;
    if (current && current.ref === ref && current.node === el) return;
    current?.detach();
    this.attached =
      ref && el ? { ref, node: el, detach: attachRef(ref, el) } : null;
  }

  /** The element's ref: the consumer's own, plus the node the trigger needs. */
  refFor(childRef: Ref<Element> | undefined): RefCallback<Element> {
    return (el) => {
      // Returning a cleanup, React 19 never calls this with null.
      if (!el) return;
      const detachChild = attachRef(childRef, el);
      this.node = el;
      this.syncTriggerRef();
      return () => {
        detachChild();
        this.node = null;
        this.syncTriggerRef();
      };
    };
  }

  private intent(name: IntentEvent, event: SyntheticEvent) {
    // A React event's `currentTarget` is cleared once its dispatch ends;
    // the replay may run after it.
    this.pending = {
      name,
      event: Object.create(event, {
        currentTarget: { value: event.currentTarget },
      }) as SyntheticEvent,
    };
    if (name === "onPointerEnter") flushSync(this.arm);
    else this.arm();
  }

  readonly onPointerEnter = (event: SyntheticEvent) =>
    this.intent("onPointerEnter", event);
  readonly onFocus = (event: SyntheticEvent) => this.intent("onFocus", event);

  /** Stable stand-ins for the trigger's handlers, each calling its latest. */
  delegates(names: readonly string[]): Record<string, (e: unknown) => unknown> {
    const out: Record<string, (e: unknown) => unknown> = {};
    for (const name of names) {
      out[name] = (event) => {
        const handler = this.latest?.[name];
        return typeof handler === "function"
          ? (handler as (e: unknown) => unknown)(event)
          : undefined;
      };
    }
    return out;
  }

  /** The trigger rendered: take its props, replay a pending intent. */
  publish(props: TriggerProps | null) {
    this.latest = props;
    this.syncTriggerRef();
    if (!props) return;
    const intent = this.pending;
    this.pending = null;
    const handler = intent ? props[intent.name] : undefined;
    const el = this.node;
    if (intent && typeof handler === "function" && el) {
      const stillFocused =
        intent.name !== "onFocus" || el.ownerDocument.activeElement === el;
      if (stillFocused) (handler as (e: SyntheticEvent) => void)(intent.event);
    }
    const next = snapshotOf(props);
    this.setSnapshot((prev) => (sameSnapshot(prev, next) ? prev : next));
  }

  readonly render: RenderDeferredTrigger = (props) => (
    <PublishTriggerProps props={props as TriggerProps} bridge={this} />
  );
}

/**
 * Renders `children` as is — same element, same DOM node, same ref — and
 * mounts the machinery `mount` returns (a base-ui Root with a Trigger whose
 * `render` is the given function) only on the first sign of intent: the
 * pointer entering the element, or focus landing on it. Until then the
 * element costs one cloneElement.
 *
 * The element is never re-parented: the trigger renders NOTHING itself — its
 * `render` captures the props it computed — and those props are merged onto
 * the element the same way base-ui merges a `render` element's own (theirs
 * first, so the element's handlers run before the trigger's and can
 * `preventBaseUIHandler()`), its ref attached to the element's node. Mounting
 * through a wrapper instead would remount the element under the pointer or the
 * focus.
 *
 * The intent event itself is replayed into the trigger: a pointer entry mounts
 * synchronously (`flushSync`), so the trigger sees the pointer type, and the
 * native `mouseenter` that follows in the same task reaches the hover
 * listeners it has just attached — the open delay, and the provider group's
 * skip-delay, run exactly as if it had always been mounted. Focus mounts on the
 * next commit (a focus can arrive inside one, where a synchronous flush is
 * refused) and is replayed while the element still holds it.
 */
export function DeferredTrigger({
  children,
  mount,
  attrs,
}: {
  children: ReactElement;
  /** The machinery, given the `render` its trigger must use. */
  mount: (render: RenderDeferredTrigger) => ReactNode;
  /** Attributes stamped on the element before the machinery mounts (`data-tooltip`). */
  attrs?: Record<string, unknown>;
}) {
  const [armed, setArmed] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [bridge] = useState(
    () => new TriggerBridge(() => setArmed(true), setSnapshot),
  );
  const childRef = elementRef(children);
  const ref = useMemo(() => bridge.refFor(childRef), [bridge, childRef]);
  const handlers = snapshot?.handlers;
  const delegates = useMemo(
    () => bridge.delegates(handlers ?? []),
    [bridge, handlers],
  );

  const own =
    armed && snapshot
      ? { ...snapshot.attrs, ...delegates }
      : {
          ...attrs,
          onPointerEnter: bridge.onPointerEnter,
          onFocus: bridge.onFocus,
        };
  const element = cloneElement(children, {
    ...mergeProps(own, children.props as Record<string, unknown>),
    ref,
  } as Record<string, unknown>);
  return (
    <>
      {element}
      {armed && mount(bridge.render)}
    </>
  );
}

/**
 * Rendered by the trigger in place of an element: publishes the props it was
 * given after every trigger render, and withdraws them on unmount.
 */
function PublishTriggerProps({
  props,
  bridge,
}: {
  props: TriggerProps;
  bridge: TriggerBridge;
}) {
  useLayoutEffect(() => bridge.publish(props));
  useLayoutEffect(() => () => bridge.publish(null), [bridge]);
  return null;
}
