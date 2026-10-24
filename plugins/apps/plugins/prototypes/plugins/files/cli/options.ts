import type { CliAction } from "@plugins/framework/plugins/cli/core";
import { prototypesDir } from "@plugins/apps/plugins/prototypes/data-dirs";
import {
  describeOptionValues,
  pickedColor,
  pickedValue,
  resolvePicks,
  type OptionPicks,
  type PrototypeOption,
} from "../core";
import { listPrototypeMetas } from "../shared/list-metas";
import { openPicksStore } from "../shared/picks";
import { prototypeDocumentUrlFormatter } from "./prototype-url";

/** The screenshot tool, as the repo's CLAUDE.md names it. */
const SCREENSHOT_SCRIPT =
  "plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts";

/**
 * `./equin prototype options <id>` — which variant of a prototype the
 * user is looking at: each option the live page declares, the value on screen
 * and whether the user picked it or it is the page's default, then the
 * document URL of exactly that variant and the command that screenshots it.
 *
 * The agent's way in to the picks. They are ONE shared record per prototype
 * that every surface reads and writes (`_picks/<id>.json`), so this is what the
 * user sees now — not a snapshot from when a conversation started. Read
 * straight off disk, through the same store and the same `resolvePicks` the
 * pane uses, with no backend running.
 *
 * Read-only by design: there is no setter. The picks are the user's; to look
 * at another variant, an agent loads the document URL with a different
 * `?<option>=<value>`, which renders it without saving anything.
 */
export const prototypeOptionsAction: CliAction<[string], object> = async (
  id,
) => {
  const metas = await listPrototypeMetas();
  const meta = metas.find((m) => m.name === id);
  if (!meta) throw new Error(`no prototype ${id} in ${prototypesDir.path}`);

  const stored = await openPicksStore(prototypesDir.path).read(id);
  const picks = resolvePicks(meta.options, stored);

  console.log(`${meta.name}  ${meta.title}`);
  if (meta.options.length === 0) {
    console.log("  declares no options (prototypes/CLAUDE.md § Options)");
  } else {
    const nameWidth = Math.max(...meta.options.map((o) => o.name.length));
    const valueWidth = Math.max(
      ...meta.options.map((o) => shownValue(o, picks).length),
    );
    for (const option of meta.options) {
      const value = shownValue(option, picks);
      const how = option.name in picks ? "picked " : "default";
      console.log(
        `  ${option.name.padEnd(nameWidth)}  ${value.padEnd(valueWidth)}  ${how}  (${describeOptionValues(option)})`,
      );
    }
  }

  // Picks the live page does not declare are kept, not dropped: a recorded
  // version can declare an option the live page has since lost, and the pane
  // applies the pick there. Said, so the record never looks smaller than it is.
  const undeclared = Object.entries(stored).filter(
    ([name]) => !meta.options.some((o) => o.name === name),
  );
  if (undeclared.length > 0) {
    const list = undeclared.map(([k, v]) => `${k}=${v}`).join(", ");
    console.log(`  also stored, not declared by the live page: ${list}`);
  }

  const doc = await prototypeDocumentUrlFormatter();
  console.log("");
  console.log("This exact variant, as a document (loading it saves nothing):");
  console.log(`  ${doc.url(id, picks)}`);
  console.log("Screenshot it:");
  console.log(
    `  ./equin run ${SCREENSHOT_SCRIPT} --path "${doc.path(id, picks)}"`,
  );
  if (meta.options.length > 0) {
    console.log(
      "Another variant: change the ?<option>=<value> query — never the user's picks.",
    );
  }
};

/**
 * The value on screen as this command prints it: a choice's value; a color's
 * `#rrggbb`, followed by its suggestion's name when it is one — the hex is
 * what an agent bakes into the page.
 */
function shownValue(option: PrototypeOption, picks: OptionPicks): string {
  const value = pickedValue(option, picks);
  if (option.kind === "choice") return value;
  const hex = pickedColor(option, picks);
  return value === hex ? hex : `${hex} (${value})`;
}
