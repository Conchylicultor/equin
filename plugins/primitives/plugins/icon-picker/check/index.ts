import {
  existsSync,
  readFileSync,
} from "@plugins/packages/plugins/timed-fs/core";
import { join } from "path";
import type { Check } from "@plugins/framework/plugins/tooling/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import {
  SYMBOLS_METADATA_REL_PATH,
  SymbolsMetadataSchema,
  symbolsMetadataContentHash,
} from "../shared/symbols-metadata";

const REGEN =
  "Run `./equin run plugins/primitives/plugins/icon-picker/scripts/gen-symbols-metadata.ts` and commit the result.";

const check: Check = {
  id: "icon-picker:symbols-metadata-in-sync",
  description:
    "icon-picker/web/internal/symbols-metadata.json is the generator's output, not edited by hand",
  async run() {
    const file = join(await getWorktreeRoot(), SYMBOLS_METADATA_REL_PATH);
    if (!existsSync(file)) {
      return {
        ok: false,
        message: `${SYMBOLS_METADATA_REL_PATH} is missing`,
        hint: REGEN,
      };
    }
    const data = SymbolsMetadataSchema.parse(
      JSON.parse(readFileSync(file, "utf8")),
    );
    if (data.contentHash !== symbolsMetadataContentHash(data)) {
      return {
        ok: false,
        message: `${SYMBOLS_METADATA_REL_PATH} was edited by hand (its content no longer matches its hash)`,
        hint: REGEN,
      };
    }
    return { ok: true };
  },
};

export default check;
