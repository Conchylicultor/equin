// The text fields' shared chrome — border, radius, fill (the surface's
// published `--field-fill` / `--field-outline`, so a field in a menu wears the
// popover's field tokens), focus ring, disabled
// (the quiet `focus-border`, not the ring halo) and invalid states — so `Input` and `Textarea` cannot drift apart. Size
// (height, padding, text rung) is NOT here: it comes from the ambient density.
export const fieldChromeClass =
  "focus-border w-full min-w-0 rounded-lg border border-field-outline bg-field-fill transition-colors placeholder:text-faint-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40";
