/**
 * The key colour of the progress bar — the one place it is chosen. No
 * themeable "key" token exists, so it borrows the `warning` palette token
 * (amber, present and themed in every theme); moving keys onto a dedicated
 * token later is an edit here only. Full class literals, so Tailwind sees them.
 */
export const KEY_TONE = {
  /** A key-change line on the rail (~85%: present, never louder than the handle). */
  line: "bg-warning/85",
  /** The hover preview's "Key change → …" readout. */
  text: "text-warning",
  /** A key name in the label lane: the tone mixed 80% toward muted text. */
  label:
    "text-[color:color-mix(in_oklab,var(--warning)_80%,var(--muted-foreground))]",
} as const;
