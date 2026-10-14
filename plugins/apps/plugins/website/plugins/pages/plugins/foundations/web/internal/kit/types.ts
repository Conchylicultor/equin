import type { Kit } from "./draw";

/** An element a card's markup is made of: an HTML span or an SVG node, both carrying `dataset` and `style`. */
export type KitElement = HTMLElement | SVGElement;

/** A card's drawing width: 302 (`std`, in a 360px card) or 482 (`wide`, in a 540px card) units, 1:1 with CSS px. */
export type CardWidth = "std" | "wide";

/**
 * What a card touches time and the document through. Everything it registers
 * (timers, frames, listeners) is disposed when the card unmounts, so a closed
 * card leaves nothing running.
 */
export interface CardCtx<D> {
  readonly key: string;
  /** The card's root element (`.k-root`). Its markup is never rebuilt: change attributes in place. */
  readonly root: HTMLElement;
  /** The card's own per-instance state: what `mount` sets up, an action reads. */
  readonly data: D;
  readonly state: number;
  go(state: number): void;
  after(ms: number, fn: () => void): () => void;
  frame(fn: (t: number) => void): () => void;
  on<K extends keyof HTMLElementEventMap>(
    target: EventTarget,
    type: K,
    fn: (e: HTMLElementEventMap[K]) => void,
    opts?: AddEventListenerOptions,
  ): () => void;
  /** Play `[[atMs, state], …]`; a newer run cancels what an older one left. Controls with `data-busy` wait for it. */
  run(seq: readonly (readonly [number, number])[]): void;
  /** Start the one-shot SMIL inside `[data-shot="<shot>"]`; a link fired by it lights and sends its token, then rests again. */
  fire(shot: string): void;
  /** Light a graph node, its edges (`[data-a][data-b]`) and their other ends; `""` clears. */
  highlight(id: string): void;
  /** Hold the autoplay a while, as a touch does. */
  hold(): void;
  /** Give a part of the card (`data-at` pieces inside `el`) a state of its own. */
  part(el: Element, state: string, still?: boolean): void;
  /** The one element under the root matching `sel` — throws when there is none. */
  q<T extends Element = HTMLElement>(sel: string): T;
  /** Every element under the root matching `sel`. */
  qa<T extends Element = HTMLElement>(sel: string): T[];
}

type Autoplay<D> =
  /** Walk `seq` (a state may repeat), holding each `every` ms (or `every[i]` for `seq[i]`). */
  | {
      seq: readonly number[];
      every: number | readonly number[];
      lead?: number;
      step?: never;
    }
  /** Call `step` on each tick: a continuous picture rather than discrete states. */
  | {
      step: (ctx: CardCtx<D>) => void;
      every: number;
      lead?: number;
      seq?: never;
    };

interface CardBase<D> {
  width?: CardWidth;
  /** The state the card opens on. */
  start?: number;
  /** The markup, rendered once on mount. A piece with `data-in="1 2"` shows in states 1 and 2 only. */
  render: (k: Kit) => string;
  /** Handlers for controls carrying `data-act="<name>"`. */
  actions?: Record<string, (ctx: CardCtx<D>, el: KitElement, e: Event) => void>;
  /** Imperative set-up after the markup is in place. */
  mount?: (ctx: CardCtx<D>) => void;
}

/**
 * One card: the drawing an open piece of the iceberg shows. A card has no
 * caption — the piece's own sentence sits right above it and is its only text.
 * Autoplay walks `states`, so a state-walking autoplay without `states` does
 * not type.
 */
export type CardDef<D = Record<string, never>> = CardBase<D> &
  (
    | { states: number; autoplay?: Autoplay<D> }
    | { states?: undefined; autoplay?: Extract<Autoplay<D>, { step: unknown }> }
  );

/** A card definition with its data type erased, as the registry holds it (each card is typed where it is defined). */
export type AnyCardDef = CardDef<any>;

/** Declare a card. The identity function that pins `D` for the card's ctx. */
export function defineCard<D = Record<string, never>>(
  def: CardDef<D>,
): CardDef<D> {
  return def;
}
