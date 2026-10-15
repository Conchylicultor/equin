import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import noUnanchoredHas from "./no-unanchored-has";
import type {
  Check,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";

/**
 * `css:message-names-primitives` — the `no-adhoc-layout` error message must name
 * every layout-mechanic primitive that exists.
 *
 * WHY THIS CHECK EXISTS. The message is the only guidance most authors ever
 * read: it is what ESLint prints at the moment they write `flex-1`. When it
 * omitted `Fill`, `fillClasses()` collected ZERO callers outside its own plugin
 * while 14 sites hand-wrote `min-w-0 flex-1` under a disable comment — and the
 * near-identical `insetClass()`, advertised in `spacing/CLAUDE.md`, collected 6.
 * Discoverability was the entire difference. A primitive nobody is told about
 * does not exist.
 *
 * WHY THE LIST IS HARDCODED IN THE RULE, NOT DERIVED. Two reasons, both
 * structural. (1) The primitive set is CLOSED by construction — one primitive
 * per layout mechanic IS the design thesis — so the root CLAUDE.md's "closed
 * list ⇒ plain data" guidance applies, not the collection-consumer rule. (2)
 * Lint rules dual-load under jiti, which cannot resolve `@plugins/*`: a registry
 * import is the one form that provably does NOT work here. So the message is
 * plain text, and THIS check is what keeps it honest.
 *
 * HOW A LAYOUT MECHANIC IS TOLD FROM A PRESENTATIONAL PRIMITIVE. Not by
 * scanning sources: it was measured, and it does not separate them — `badge`,
 * `toggle-chip`, `selection-indicator` and `color-picker` all emit banned
 * structural tokens (`inline-flex`, `shrink-0`, `absolute`) for their own
 * internals, exactly as `fill` and `pin` do for their callers. There is no
 * threshold that splits the two sets.
 *
 * So the classification is a PARTITION over the DIRECTORY LISTING, declared in
 * exactly one place (`NOT_A_LAYOUT_MECHANIC` below), with the layout side
 * DERIVED as the complement:
 *
 *     layout mechanics  =  dirs(css/plugins/*)  −  NOT_A_LAYOUT_MECHANIC
 *
 * Three properties make it un-driftable — every divergence is a failure, never
 * a silent pass:
 *
 *   1. FAIL-CLOSED DEFAULT. A new directory is a layout mechanic until someone
 *      says otherwise, so the failure mode of forgetting is a red check, not a
 *      silently unadvertised primitive. (This is the whole point: `Layer`,
 *      `Rigid` and `Plane` land as new directories here.)
 *   2. NO STALE ENTRIES. An entry naming a directory that no longer exists
 *      fails, so a deleted primitive cannot leave a classification behind.
 *   3. NO CONTRADICTIONS. An entry declared presentational whose name the
 *      message DOES advertise fails, so the two halves cannot disagree about
 *      the same primitive.
 *
 * There is no second list of layout primitives to keep in sync with the message
 * — the message IS that list, and this check reads it.
 */

const CSS_PLUGIN_DIR = "plugins/primitives/plugins/css/plugins";
const RULE_FILE = "plugins/primitives/plugins/css/lint/no-adhoc-layout.ts";
const THIS_CHECK = "plugins/primitives/plugins/css/check/index.ts";

/**
 * The css sub-plugins that are NOT layout mechanics — chrome, leaves, controls
 * and tooling. They are legitimately absent from a message about composing
 * layout; naming them there would be noise. Everything else under
 * `css/plugins/*` must be advertised by the rule.
 *
 * Adding an entry here REMOVES a primitive's obligation to be advertised, so it
 * is a deliberate, reviewed act with a stated reason — never a default.
 */
const NOT_A_LAYOUT_MECHANIC: Record<string, string> = {
  badge: "identity chip (a rigid leaf), not a way to arrange boxes",
  "bouncing-dots": "activity indicator — a leaf",
  card: "chrome (border + bg + pad); structure is chosen before chrome",
  "color-picker": "a control, not a layout mechanic",
  "control-panel":
    "the vocabulary of ONE surface (a data-control panel's sections/rows/fields), not a general arrangement mechanic",
  "control-size": "a token standard (control heights) + its own lint rule",
  "grow-relay":
    "the grow-request handshake — who asks the row for its slack and who relays the ask — a contract BETWEEN boxes, not a box to reach for. The box you reach for is Fill (or growClass() when the content floor is wanted), both of which the message already names. Note `\\bGrow\\b` does not match inside `GrowRelay`, so the sibling `grow` plugin and this entry cannot collide.",
  "icon-auto": "a token standard (slot-icon sizing) + its own lint rule",
  "layout-harness":
    "the geometry test harness for the primitives, not a primitive",
  "link-chip": "a navigational leaf (composes Badge)",
  placeholder: "muted loading/empty text — a leaf",
  "radio-group": "a form control + its own lint rule",
  radius: "a token standard (corner radius) + its own lint rule",
  rail: "a dev-only guard on who owns a region's content edge — an inset audit, not a box to reach for",
  "selection-indicator": "checkbox/radio glyph boxes — leaves",
  slider:
    "a form control (a themed range input) — a leaf, and a sibling of `switch` and `radio-group` above. It takes a `className` for its own width the way any leaf does; nothing about it arranges other boxes.",
  "space-ramp":
    "a token standard (the spacing ramp's steps and the class each names, generated from app.css) — the scale Stack/Inset/Grid draw their gap and pad from, not a box to reach for. The boxes are Stack and Inset, which the message already names.",
  spinner: "loading indicator — a leaf",
  "activity-ring": "status glyph around a status dot — a leaf",
  "status-dot": "status glyph — a leaf",
  surface: "elevation chrome (bg/border/shadow), orthogonal to arrangement",
  switch: "a form control (track + knob) — a leaf",
  "theme-boundary":
    "theming chrome — it says which theme a subtree wears (the data-theme-scope tag, the portal forward that carries it, and the canvas that tag implies) and takes `as` precisely so it does NOT decide what kind of box it is. Sibling of `surface` above: that one is elevation chrome, this one is palette chrome, and both are orthogonal to arrangement. Naming it in a message about composing layout would send authors reaching for it to arrange boxes, which is the one thing it deliberately cannot do — it emits no display class at all.",
  "toggle-chip": "a stateful control (composes Badge)",
  "ui-kit": "the shadcn/cn/global-stylesheet substrate, not a layout primitive",
  "z-layers": "a token standard (the z scale) + its own lint rule",
};

/** `viewport-overlay` → `ViewportOverlay`. The component name the message uses. */
export function pascalCase(dir: string): string {
  return dir
    .split("-")
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join("");
}

/**
 * Does `messages` advertise the primitive living in `<dir>`?
 *
 * Two accepted forms, because two exist in practice:
 *   - its COMPONENT name as a whole word (`Fill`, `ViewportOverlay`) — the
 *     normal case, and case-sensitive so `fill`/`fillClasses` don't count; and
 *   - its plugin PATH (`css/plugins/spacing`) — for a plugin whose components
 *     aren't named after the directory (`spacing` ships `Stack`/`Inset`).
 *
 * The bare lowercase directory name is deliberately NOT accepted: `line`,
 * `text`, `grid` and `row` all occur as ordinary English in the prose, which
 * would make the check pass on a message that never named the primitive.
 */
export function namesPrimitive(messages: string, dir: string): boolean {
  const component = pascalCase(dir);
  const asWord = new RegExp(`\\b${component}\\b`);
  return asWord.test(messages) || messages.includes(`css/plugins/${dir}`);
}

/**
 * The rule's user-facing message text: everything between the `messages: {` key
 * and the `defaultOptions` that follows it (both structural landmarks of an
 * `ESLintUtils.RuleCreator` rule), with `//` comment lines dropped — a name
 * mentioned only in a code comment is not advertised to anyone.
 *
 * Read as TEXT rather than imported: a check under `check/` and a lint rule
 * under `lint/` sit in different tsconfig programs, and the rule pulls in the
 * whole `@typescript-eslint/utils` surface. The text is all this needs.
 */
export function extractMessages(src: string): string | null {
  const start = src.indexOf("messages: {");
  if (start === -1) return null;
  const end = src.indexOf("defaultOptions", start);
  if (end === -1) return null;
  return src
    .slice(start, end)
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

const check: Check = {
  id: "css:message-names-primitives",
  description:
    "the no-adhoc-layout message must name every layout-mechanic primitive under css/plugins/* (an unadvertised primitive gets no callers)",
  async run(): Promise<CheckResult> {
    const root = await getWorktreeRoot();

    const dirs = readdirSync(join(root, CSS_PLUGIN_DIR), {
      withFileTypes: true,
    })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();

    const src = readFileSync(join(root, RULE_FILE), "utf8");
    const messages = extractMessages(src);
    if (messages === null) {
      return {
        ok: false,
        message: `${RULE_FILE}: could not locate the rule's \`messages: { … }\` block (expected a \`messages: {\` key followed by \`defaultOptions\`).`,
        hint: "Keep the rule in the standard ESLintUtils.RuleCreator shape, or update extractMessages() in this check to match.",
      };
    }

    // (2) No stale entries — a classification for a directory that is gone.
    const stale = Object.keys(NOT_A_LAYOUT_MECHANIC).filter(
      (d) => !dirs.includes(d),
    );
    if (stale.length > 0) {
      return {
        ok: false,
        message: `NOT_A_LAYOUT_MECHANIC classifies css sub-plugins that no longer exist: ${stale.join(", ")}`,
        hint: `Drop those entries from ${THIS_CHECK}.`,
      };
    }

    // (3) No contradictions — declared presentational, yet advertised as an answer.
    const contradictory = Object.keys(NOT_A_LAYOUT_MECHANIC).filter((d) =>
      namesPrimitive(messages, d),
    );
    if (contradictory.length > 0) {
      return {
        ok: false,
        message: `declared NOT a layout mechanic, yet named in the no-adhoc-layout message: ${contradictory.join(", ")}`,
        hint: "Either remove the entry (it IS a layout mechanic the rule redirects to) or stop naming it in the message.",
      };
    }

    // (1) Fail-closed: everything not declared presentational must be advertised.
    const missing = dirs
      .filter((d) => !(d in NOT_A_LAYOUT_MECHANIC))
      .filter((d) => !namesPrimitive(messages, d));
    if (missing.length > 0) {
      return {
        ok: false,
        message:
          `the no-adhoc-layout message does not name these css layout primitives: ${missing.join(", ")}. ` +
          "An unadvertised primitive gets no callers — that is how fillClasses() ended up with zero.",
        hint:
          `Add each to the indexed list in ${RULE_FILE}'s \`adhocLayout\` message (under the mechanic it owns), ` +
          "and document it in the css skill + css/CLAUDE.md. If it is NOT a layout mechanic (chrome, a leaf, a control, a token standard), " +
          "add it to NOT_A_LAYOUT_MECHANIC in this check with the reason why.",
      };
    }

    return { ok: true };
  },
};

export default [check, noUnanchoredHas];
