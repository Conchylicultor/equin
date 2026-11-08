// Types for `lucide-set.js` — see there for why it is JS.
import type { IconifyJSON } from "@iconify/types";

export declare const LUCIDE_SET: {
  readonly name: string;
  readonly version: string;
  /** The whole Lucide set, parsed — a lazy chunk of the worker. */
  readonly load: () => Promise<IconifyJSON>;
};
