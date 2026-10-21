import {
  cn,
  SURFACE_LEVELS,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";

/**
 * The look of a button floated ON the canvas — the add rail's `+` / Compare and
 * the Side by side / Swipe switch, one family: the floating-chrome glass
 * (`SURFACE_LEVELS.float`: its fill, blur and hairline border) at a button's
 * own corner (`rounded-lg`) and the theme's lighter rail drop (`shadow-xl`),
 * in the foreground ink, stepping to the muted surface under the pointer and
 * fading well back when disabled. On an `IconButton variant="floating"`, whose
 * solid fill the glass replaces.
 */
export const railButtonClass = cn(
  SURFACE_LEVELS.float,
  "rounded-lg text-foreground shadow-xl hover:bg-muted disabled:opacity-35",
);
