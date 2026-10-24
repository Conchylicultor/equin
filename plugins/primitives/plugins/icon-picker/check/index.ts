import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { Check } from "@plugins/framework/plugins/tooling/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import {
  SYMBOLS_METADATA_REL_PATH,
  SymbolsMetadataSchema,
  symbolsMetadataContentHash,
  symbolsMetadataInputsHash,
} from "../shared/symbols-metadata";

const REGEN =
  "Run `./equin run plugins/primitives/plugins/icon-picker/scripts/gen-symbols-metadata.ts` and commit the result.";

const check: Check = {
  id: "icon-picker:symbols-metadata-in-sync",
  description:
    "icon-picker/web/internal/symbols-metadata.json was generated for the installed Material Symbols sets and not edited by hand",
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
    const inputs = symbolsMetadataInputsHash();
    if (data.inputsHash !== inputs) {
      return {
        ok: false,
        message: `${SYMBOLS_METADATA_REL_PATH} is stale (file=${data.inputsHash}, installed sets=${inputs})`,
        hint: REGEN,
      };
    }
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
