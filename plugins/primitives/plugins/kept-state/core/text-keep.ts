/**
 * The `keep` prop every text-input primitive requires (ui-kit `Input` /
 * `Textarea`, the `TextEditor` and its composer, `useEditableField`): the one
 * decision a new field cannot skip — does what the user types here survive a
 * reload and a tab switch (tab residency unmounts hidden tabs), or is it
 * throwaway? A forgotten draft is a type error, not a missing feature.
 *
 * - a `useKept` / `useDraft` binding — the text is kept state (work or view);
 * - a field that keeps its own text (`useEditableField`'s result, minted with
 *   `keptText`) — kept, the field decided how;
 * - one string field of a kept object (`keptField(binding, "text")`) — kept;
 * - `transient("<why>")` — throwaway by design (a password, a filter whose
 *   result is the point, a field committed on every keystroke elsewhere).
 */

/**
 * What `submitKept` needs of one kept entry: its latest value, a way to show
 * a value without writing it, and a clear that holds only while the entry
 * still stores what was sent. Minted by `useDraft` / `useKept` (their 4th
 * element) — never built by a caller.
 */
export interface KeptHandle<T> {
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

declare const keptTextBrand: unique symbol;

/**
 * Text a primitive keeps itself (`useEditableField`: pending text is kept as
 * work until the server acks it). Minted by `keptText` only.
 */
export interface KeptText {
  readonly [keptTextBrand]: true;
  readonly value: string;
  readonly onChange: (next: string) => void;
}

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

/**
 * Brand text that is kept by its owner as a `keep` value: a primitive that
 * persists it itself (`useEditableField`), or a host handing a leaf one entry
 * of a kept collection (a card of a kept chain of drafts). A feature keeps its
 * own text with `useKept` / `keptField` — never by wrapping a `useState` here.
 */
export function keptText(
  value: string,
  onChange: (next: string) => void,
): KeptText {
  return { value, onChange } as unknown as KeptText;
}

/**
 * One text field of a kept object (a `useKept` / `useDraft` binding over
 * `{ text, picked, … }`) as a `keep` value: the field shows `value[key]`, and
 * typing writes it back into the object. The object stays the one kept entry
 * (so `submitKept` still clears it whole).
 *
 * ```tsx
 * const draft = useDraft(launchDraftStore, { text: "", model: null });
 * <ComposerField keep={keptField(draft, "text")} />
 * ```
 */
export function keptField<T, K extends StringKeys<T>>(
  binding: KeptBinding<T>,
  key: K,
): KeptText {
  const [value, set] = binding;
  return keptText(value[key] as string, (next) =>
    set((prev) => ({ ...prev, [key]: next })),
  );
}

/** The keys of `T` whose value is a string. */
type StringKeys<T> = {
  [K in keyof T]-?: T[K] extends string ? K : never;
}[keyof T];

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
  return { value: text.value, set: text.onChange };
}
