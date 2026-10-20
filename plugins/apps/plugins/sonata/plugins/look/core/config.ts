import { defineConfig } from "@plugins/config_v2/core";
import { enumField } from "@plugins/fields/plugins/enum/plugins/config/core";

/**
 * Every look the Sonata roll can be drawn in, in picker order — the lane, the
 * grid, the falling notes, and the keys below them, all from one switch.
 *
 *  - `immersive` — the player's night stage (proto-1792113547-2qr6g7): a
 *                  blue-black lane with bar and beat rules, roomy rounded note
 *                  bars in one colour per track, crisp white/black keys under a sky
 *                  landing line. The default.
 *  - `flat`      — the Synthesia stage with flat keys: a dark lane, faint white
 *                  rules, opaque note bars, and keys as solid fills with strong
 *                  dark borders, a lit key painted in the note's actual colour.
 *  - `realistic` — the same stage under skeuomorphic ivory/ebony keys:
 *                  gradients, bevels, gloss, and a pressed-key depression.
 *  - `sketch`    — the whole roll as a drawing on paper: cream ground with a
 *                  paper grain, graphite rules, notes inked by a wobbling pen,
 *                  and hand-drawn keys.
 *
 * ONE axis, on purpose. This used to be two — a `digital`/`sketch` look and the
 * keyboard's own `flat`/`realistic` key style — but they were never independent:
 * paper lane under glossy ivory keys is not a combination worth reaching, so the
 * drawn look simply never consulted the key style. Three of the four pairs were
 * reachable, which is to say it was always one axis with three values wearing two
 * controls. Naming it as one leaves the unwanted pair with no spelling at all,
 * rather than a row that sits in the popover doing nothing.
 *
 * This array is the single source: {@link SonataLook} is derived from it, so the
 * palette table, the picker's options and the {@link asSonataLook} narrowing
 * cannot list different looks.
 */
export const SONATA_LOOKS = [
  { value: "immersive", label: "Immersive" },
  { value: "flat", label: "Flat (Synthesia)" },
  { value: "realistic", label: "Realistic" },
  { value: "sketch", label: "Sketch" },
] as const;

/**
 * A look. NOT a theme: the roll is deliberately theme-independent — it reads the
 * same in light and dark — and stays that way. The look only decides WHICH fixed
 * palette those surfaces are pinned to (see `styles.ts`).
 */
export type SonataLook = (typeof SONATA_LOOKS)[number]["value"];

/**
 * The look a fresh install renders in, spelled once. It is the config's default
 * AND the ink the piano roll's grid and labels hold before the first `setLook()`
 * reaches them, so those two must not be able to drift apart.
 */
export const SONATA_DEFAULT_LOOK: SonataLook = "immersive";

export const sonataLookConfig = defineConfig({
  fields: {
    look: enumField({
      label: "Look",
      description:
        "How the whole roll is drawn — lane, grid, notes, and the keys below them.",
      options: SONATA_LOOKS.map((l) => ({ value: l.value, label: l.label })),
      default: SONATA_DEFAULT_LOOK,
    }),
  },
});

/**
 * Narrow a config read to {@link SonataLook}. `enumField` types as `string`
 * (its zod schema is what rejects an unknown value, at the config layer), so
 * every consumer funnels its read through this instead of casting.
 *
 * Throws on an unrecognised id rather than falling back to the default: the
 * descriptor's `z.enum` — built from this same list — has already refused
 * anything else, so a value arriving here that isn't a look is a defect to see,
 * not to paper over.
 */
export function asSonataLook(value: string): SonataLook {
  const look = SONATA_LOOKS.find((l) => l.value === value);
  if (!look) {
    throw new Error(
      `asSonataLook: unknown Sonata look "${value}" (expected one of ${SONATA_LOOKS.map((l) => l.value).join(", ")})`,
    );
  }
  return look.value;
}
