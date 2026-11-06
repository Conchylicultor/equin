// Types for `bundled-set.js` — see there for why it is JS.
import type { IconifyJSON } from "@iconify/types";

export declare const BUNDLED_SET: {
  readonly name: string;
  readonly version: string;
  /** The whole 400-weight set, parsed — a lazy chunk of the worker. */
  readonly load: () => Promise<IconifyJSON>;
};
