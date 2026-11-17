/**
 * The `keep` prop every text-input primitive requires (ui-kit `Input` /
 * `Textarea`, the `TextEditor` and its composer, `useEditableField`): the one
 * decision a new field cannot skip — does what the user types here survive a
 * reload and a tab switch (tab residency unmounts hidden tabs), or is it
 * throwaway? A forgotten draft is a type error, not a missing feature.
 *
 * - a `useKept` / `useDraft` binding — the text is kept state (work or view);
 * - a field that keeps its own text (`useEditableField`'s `keep`) — kept, the
 *   field decided how;
 * - a string part of a kept value (`keptField(binding, "text")`, through
 *   `keptItem` for one entry of a kept list) — kept;
 * - `transient("<why>")` — throwaway by design (a password, a filter whose
 *   result is the point, a field committed on every keystroke elsewhere).
 */

/**
 * What `submitKept` needs of one kept entry: its latest value, a way to show
 * a value without writing it, and a clear that holds only while the entry
 * still stores what was sent. Minted by `useDraft` / `useKept` (their 4th
 * element) — never built by a caller: the brand makes a hand-built tuple of
 * `useState`'s pair and a fake handle no binding.
 */
declare const keptHandleBrand: unique symbol;

export interface KeptHandle<T> {
  readonly [keptHandleBrand]: true;
  /** The latest value (as set, before its write lands). */
  current(): T;
  /** Make sure `current()` is in storage now. */
  flush(): void;
  /** Show the initial value without touching storage. */
  showInitial(): void;
  /** Clear the entry if storage still holds `sent`; reset what is shown if it still shows `sent`. */
  clearIfStill(sent: T): void;
}

/** A setter as `useState`'s: a value, or a function of the previous one. */
export type KeptSetter<T> = (action: T | ((prev: T) => T)) => void;

/**
 * A kept value as a `useState` drop-in, plus its handle for `submitKept`:
 * `[value, set, clear, handle]`. The handle is what makes it a binding — a
 * plain `useState` pair is not one.
 */
export type KeptBinding<T> = readonly [
  T,
  KeptSetter<T>,
  () => void,
  KeptHandle<T>,
];

declare const keptPartBrand: unique symbol;

/**
 * One part of a kept value — the whole of a `useKept` / `useDraft` binding
 * (`keptPart`), one field of it (`keptField`) or one item of a kept list
 * (`keptItem`), projected again as deep as needed — handed down to whoever
 * shows and edits it. Showing it and setting it reads and writes the kept
 * entry it was projected from, so the entry stays the one thing `submitKept`
 * clears.
 *
 * Only a projection of a binding mints one: a `useState` pair has no spelling
 * as a part, so a host cannot pass plain state off as kept to a leaf.
 */
export interface KeptPart<T> {
  readonly [keptPartBrand]: true;
  readonly value: T;
  readonly set: KeptSetter<T>;
}

/** Kept text: a part of a kept value that is a string (`keptField(draft, "text")`). */
export type KeptText = KeptPart<string>;

/** What a part is projected from: a binding, or another part. */
export type KeptSource<T> = KeptBinding<T> | KeptPart<T>;

declare const transientBrand: unique symbol;

/** Text that is throwaway by design — minted by `transient("<why>")` only. */
export interface Transient {
  readonly [transientBrand]: true;
  readonly kind: "transient";
  readonly reason: string;
}

/** What a text-input primitive's required `keep` prop accepts. */
export type TextKeep = KeptBinding<string> | KeptText | Transient;

/**
 * Mark a field's text as throwaway, saying why ("password", "filter: the
 * result is the point", "committed on every keystroke"). The field keeps its
 * own `value` / `onChange`. The reason is the review surface: a half-typed
 * message is never transient.
 */
export function transient(reason: string): Transient {
  if (reason.trim() === "")
    throw new Error("transient(reason): say why this text may be lost");
  return { kind: "transient", reason } as Transient;
}

function mintPart<T>(value: T, set: KeptSetter<T>): KeptPart<T> {
  return { value, set } as unknown as KeptPart<T>;
}

function isBinding<T>(source: KeptSource<T>): source is KeptBinding<T> {
  return Array.isArray(source);
}

/** A binding as a part, to hand down whole (`<Panel draft={keptPart(binding)} />`). */
export function keptPart<T>(source: KeptSource<T>): KeptPart<T> {
  if (!isBinding(source)) return source;
  const [value, set] = source;
  return mintPart(value, set);
}

/**
 * One field of a kept object as a part: it shows `value[key]`, and setting it
 * writes the field back into the object (the object stays the one kept entry,
 * so `submitKept` still clears it whole). A string field is a `keep` value.
 *
 * ```tsx
 * const draft = useDraft(launchDraftStore, { text: "", model: null });
 * <ComposerField keep={keptField(draft, "text")} />
 * ```
 */
export function keptField<T extends object, K extends string & keyof T>(
  source: KeptSource<T>,
  // A list's items are `keptItem`'s: spreading a list as an object would
  // turn it into one.
  field: T extends readonly unknown[] ? never : K,
): KeptPart<T[K]> {
  const key: K = field;
  const { value, set } = keptPart(source);
  return mintPart(value[key], (action) =>
    set((prev) => ({
      ...prev,
      [key]:
        typeof action === "function"
          ? (action as (p: T[K]) => T[K])(prev[key])
          : action,
    })),
  );
}

/**
 * One item of a kept list as a part, found by identity (`(c) => c.id === id`),
 * never by position — a write that lands after the list was reordered still
 * reaches its own item. It shows the matching item, and setting it replaces
 * that item in the list (a card of a kept chain of drafts). An item gone by
 * the time a write lands (removed in the same frame) takes no write: there is
 * nothing left to write into.
 */
export function keptItem<E>(
  source: KeptSource<E[]>,
  isItem: (item: E) => boolean,
): KeptPart<E> {
  const { value, set } = keptPart(source);
  const index = value.findIndex(isItem);
  if (index < 0) throw new Error("keptItem: no item of the kept list matches");
  return mintPart(value[index] as E, (action) =>
    set((prev) => {
      const at = prev.findIndex(isItem);
      if (at < 0) return prev;
      const next = prev.slice();
      next[at] =
        typeof action === "function"
          ? (action as (p: E) => E)(prev[at] as E)
          : action;
      return next;
    }),
  );
}

/** True for `transient(…)`. */
export function isTransient(keep: unknown): keep is Transient {
  return (
    typeof keep === "object" &&
    keep !== null &&
    !Array.isArray(keep) &&
    (keep as { kind?: unknown }).kind === "transient"
  );
}

/**
 * The value and setter a kept `keep` drives the field with, or `null` for
 * `transient` (the field keeps its caller's `value` / `onChange`).
 */
export function resolveTextKeep(
  keep: TextKeep,
): { value: string; set: (next: string) => void } | null {
  if (isTransient(keep)) return null;
  if (Array.isArray(keep)) {
    const binding = keep as KeptBinding<string>;
    return { value: binding[0], set: (next) => binding[1](next) };
  }
  const text = keep as KeptText;
  return { value: text.value, set: (next) => text.set(next) };
}
