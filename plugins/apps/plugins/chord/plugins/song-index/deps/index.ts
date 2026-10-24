// The song index's dependency: Sheet Sage's two dump files, collected into
// infra/deps' registry through the `default` array (Settings → Dependencies,
// `./equin deps install sheetsage-dumps`).
import { sheetSageDumps } from "./internal/sheetsage";

export { SHEETSAGE_DUMP_FILES, sheetSageDumps } from "./internal/sheetsage";

export default [sheetSageDumps];
