/**
 * Identity of the emojibase data mirror, shared by this plugin's picker (which
 * hands frimousse its `emojibaseUrl`) and its server barrel (which registers
 * the mirror). Plugin-private DRY — never imported cross-plugin.
 */

/** Mirror id → URL segment `/api/asset-mirror/emojibase/…`. */
export const EMOJIBASE_MIRROR_ID = "emojibase";

/** The one locale the picker loads (its search labels are English). */
export const EMOJIBASE_LOCALE = "en";
