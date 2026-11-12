/**
 * A script-only state attribute: page state stamped on a high-up element (the
 * document root, `<body>`, an app container) for SCRIPT to read, which flips
 * often enough that no stylesheet may select on it.
 *
 * Why: a rule that names an attribute of an ancestor (`[data-x="y"] .z`,
 * `.z:not([data-x] *)`, a Tailwind `in-data-[x=y]:` variant) makes Chrome
 * restyle every element the rule could match — or the whole subtree — on each
 * change of it. `data-input-modality` on `<html>` cost ~7,000 restyled
 * `focus-ring` hosts per keyboard ⇄ pointer flip until the rings moved to a
 * mark on the focused element (`ui-kit/web/theme/input-modality.tsx`).
 *
 * Declaring one here is what puts it under `script-state:no-stylesheet-reads`,
 * which rejects every stylesheet selector (plugin CSS, Tailwind variants)
 * naming it. The attribute must be a string literal — the check reads it from
 * the source. Write and read it through the returned handle, so the code that
 * owns the state is the declaration.
 */
export type StateAttribute = `data-${string}`;

/**
 * Read and write only — no `attribute` getter, so no code can build a
 * selector string from it out of the scan's sight.
 */
export interface ScriptState {
  /** The value on `el`; undefined when absent. */
  read(el: Element): string | undefined;
  /** Set it on `el`, or remove it with `undefined`. */
  write(el: Element, value: string | undefined): void;
}

export function defineScriptState(attribute: StateAttribute): ScriptState {
  return {
    read: (el) => el.getAttribute(attribute) ?? undefined,
    write: (el, value) => {
      if (value === undefined) el.removeAttribute(attribute);
      else el.setAttribute(attribute, value);
    },
  };
}
