import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import type {
  Check,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import {
  collectTokenGroups,
  collectTokenGroupVars,
} from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { grepCode } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import {
  PICK_EMPHASES,
  PICK_FAMILIES,
  PICK_STEPS,
  PICK_RUNGS,
  TEXT_TREATMENTS,
  TYPE_ROLES,
  TYPE_SUBSCALE,
  roleTokenKeys,
} from "@plugins/primitives/plugins/css/plugins/text/core";
import { typeScaleGroup } from "../core";

/**
 * `type-scale:closed-role-ladder` — the typographic role ladder stays CLOSED.
 *
 * The type system is one closed set of roles (`TYPE_ROLES` in the text
 * plugin's core): components pick a role (`<Text variant>` / `text-<role>`),
 * themes set role tokens, and `--font-scale` multiplies every role. It drifted
 * once already — two theme passes minted component-named type tokens
 * (`ChipCompact`, `ToolBadge`, `Count`, a sidebar-metrics `sidebarLabel*`) and
 * custom `text-<name>` utilities that no lint rule saw, until "make the text one
 * step bigger" meant editing thirteen values. Every leak that drift used is a
 * failure here:
 *
 *   1. the `type-scale` group declares exactly the keys `TYPE_ROLES` implies
 *      (`roleTokenKeys()`) plus the non-role keys listed below — no more, no
 *      fewer;
 *   2. no OTHER token group declares a font size, line height or weight var;
 *   3. every ui-kit `@utility` that sets font-size / line-height / font-weight is
 *      a utility the ladder derives (`text-<role>`, `text-<role>-compact`,
 *      `font-<role>` / `font-<role>-strong` for a token-weight role), each
 *      derived one exists, and each size/line-height is multiplied by
 *      `var(--font-scale)`;
 *   4. the `no-adhoc-typography` message names every `<Text>` variant and the
 *      sub-scale (it is the only guidance most authors read);
 *   5. no `.ts(x)` outside the text and type-scale plugins reads a raw
 *      `var(--font-size-*)` / `var(--line-height-*)` (it would skip the scale —
 *      `typeVar()` is the sanctioned spelling);
 *   6. every ROLE PICKER (`ROLE_PICKERS` below — a token whose VALUE names a
 *      rung, applied by one literal style-query class per rung, since a class
 *      table Tailwind must see cannot be derived) covers exactly its rungs, each
 *      with exactly the utilities the ladder gives it: the tooltip's
 *      (`--tooltip-role`, ui-kit's tooltip: each role's `text-<role>`, and
 *      `font-<role>-strong` under `--tooltip-emphasis: strong` for exactly the
 *      roles with a strong step) and the generic part picker's (`--role-pick`,
 *      the text plugin's role-pick tables behind `<Text pick>`: every rung of
 *      `PICK_RUNGS`, base and compact);
 *   6b. every token-group key ending `Role` / `Emphasis` / `Family` / `Step` — a part's
 *      pick tokens — declares `values` equal to `PICK_RUNGS` / `PICK_EMPHASES`
 *      / `PICK_FAMILIES` / `PICK_STEPS` (the overlay group's tooltip pair, which predates the
 *      generic picker and has its own vocabulary, is the one listed
 *      exception), so a theme cannot name a value no table applies.
 *
 * This check is the ONE authority for (1): the group carries no load-time
 * assertion of its own.
 */

const APP_CSS =
  "plugins/primitives/plugins/css/plugins/ui-kit/web/theme/app.css";
const TYPOGRAPHY_RULE =
  "plugins/primitives/plugins/css/plugins/text/lint/no-adhoc-typography.ts";
const TYPE_SCALE_GROUP =
  "plugins/ui/plugins/tokens/plugins/type-scale/core/group.ts";
const THIS_CHECK =
  "plugins/ui/plugins/tokens/plugins/type-scale/check/index.ts";
const TYPE_SCALE_GROUP_ID = "type-scale";
const TOOLTIP =
  "plugins/primitives/plugins/css/plugins/ui-kit/web/components/ui/tooltip.tsx";
const ROLE_PICK =
  "plugins/primitives/plugins/css/plugins/text/web/internal/role-pick.ts";

/**
 * Every `[@container_style(--<roleVar>:<rung>)…]:<utility>` class in a picker
 * source, as `<rung> → <utility>` (a compound `…_and_style(--x:y)` query is
 * tagged `<rung>+<x>:<y> → <utility>`). Order-free and deduplicated.
 */
export function rolePickerPairs(src: string, roleVar: string): Set<string> {
  const re = new RegExp(
    String.raw`\[@container_style\(--${roleVar}:([a-z0-9]+)\)(?:_and_style\(--([a-z-]+):([a-z]+)\))?\]:([a-z0-9-]+)`,
    "g",
  );
  return new Set(
    [...src.matchAll(re)].map((m) =>
      m[2] === undefined
        ? `${m[1]} → ${m[4]}`
        : `${m[1]}+${m[2]}:${m[3]} → ${m[4]}`,
    ),
  );
}

/** The roles with a strong step (`font-<role>-strong`). */
function strongRoles(): string[] {
  return Object.entries(TYPE_ROLES)
    .filter(([, spec]) => "strong" in spec && spec.strong)
    .map(([r]) => r);
}

/**
 * The role pickers: each source, its rung var, and the exact
 * `<rung> → <utility>` set the ladder implies for it. Adding a picker is one
 * entry here (and its literal table) — rule 6 then holds it to the ladder.
 */
const ROLE_PICKERS: ReadonlyArray<{
  id: string;
  file: string;
  roleVar: string;
  expected: () => Set<string>;
  hint: string;
}> = [
  {
    id: "tooltip",
    file: TOOLTIP,
    roleVar: "tooltip-role",
    expected: () =>
      new Set([
        ...Object.keys(TYPE_ROLES).map((r) => `${r} → text-${r}`),
        ...strongRoles().map(
          (r) => `${r}+tooltip-emphasis:strong → font-${r}-strong`,
        ),
      ]),
    hint:
      "Give every TYPE_ROLES role one `[@container_style(--tooltip-role:<role>)]:text-<role>` entry in TOOLTIP_ROLE_CLASS, and every role with a strong step a " +
      "`[@container_style(--tooltip-role:<role>)_and_style(--tooltip-emphasis:strong)]:font-<role>-strong` one — written literally, so Tailwind sees it.",
  },
  {
    id: "role-pick",
    file: ROLE_PICK,
    roleVar: "role-pick",
    expected: () => {
      const out = new Set<string>();
      for (const rung of PICK_RUNGS) {
        if ((TYPE_SUBSCALE as readonly string[]).includes(rung)) {
          // The sub-scale is below role granularity: it does not compact.
          out.add(`${rung} → text-${rung}`);
          continue;
        }
        out.add(`${rung} → text-${rung}`);
        // The compact table: the compact rung while the part's step is
        // `ambient`, the rung itself under `base`.
        out.add(`${rung}+role-step:ambient → text-${rung}-compact`);
        out.add(`${rung}+role-step:base → text-${rung}`);
        const spec = TYPE_ROLES[rung as keyof typeof TYPE_ROLES];
        // A role whose own compact utility carries no weight
        // (`tag`, like `<Text variant="tag">`) also needs its `font-<role>`.
        if (spec.compact === "own") out.add(`${rung} → font-${rung}`);
      }
      return out;
    },
    hint:
      "Give every PICK_RUNGS rung its `[@container_style(--role-pick:<rung>)]:text-<rung>` entry in RUNG_CLASS and its `…:text-<rung>-compact` one in " +
      "RUNG_COMPACT_CLASS, under `_and_style(--role-step:ambient)`, beside `…_and_style(--role-step:base)]:text-<rung>` (the 2xs / 3xs sub-scale: plain `text-<rung>` in both) — written literally, so Tailwind sees it.",
  },
];

/** Token keys that name a part's pick, by axis — and the vocabulary each must declare. */
const PICK_AXES: ReadonlyArray<{ suffix: string; values: readonly string[] }> =
  [
    { suffix: "Role", values: PICK_RUNGS },
    { suffix: "Emphasis", values: PICK_EMPHASES },
    { suffix: "Family", values: PICK_FAMILIES },
    { suffix: "Step", values: PICK_STEPS },
  ];

/**
 * Keys ending in a pick suffix that are not a part's pick. Each is reviewed:
 * - the overlay group's tooltip pair predates the generic picker and keeps its
 *   own vocabulary (`regular | strong` emphasis), held by rule 6's tooltip
 *   picker instead;
 * - `icons.iconFamily` names an ICON set's family (Material Symbols style),
 *   not a type family.
 */
const PICK_AXIS_EXCEPTIONS: readonly string[] = [
  "overlay.tooltipRole",
  "overlay.tooltipEmphasis",
  "icons.iconFamily",
];

/**
 * Spelling a raw type var in TS is exempted for the ladder's two owners (the
 * text and type-scale plugins), in their own `exempt/index.ts`.
 */
const RAW_VARS = "type-scale:closed-role-ladder:raw-vars";

/**
 * The type-scale keys that are NOT a role's: the scale itself, the inherited
 * base, the reading measure, the sub-scale below role granularity, and the four
 * shared weights the frozen roles read. Adding a key here widens the closed
 * ladder, so it is a deliberate, reviewed act — a component-named size never
 * belongs here (make it a role in `TYPE_ROLES`, or pick an existing one).
 */
const NON_ROLE_KEYS: readonly string[] = [
  "fontScale",
  "fontSizeBase",
  "lineHeightBase",
  "measureReading",
  ...TYPE_SUBSCALE.flatMap((s) => [`font-size-${s}`, `line-height-${s}`]),
  "fontWeightNormal",
  "fontWeightMedium",
  "fontWeightSemibold",
  "fontWeightBold",
];

/** A token var that carries type metrics (size, leading, weight). */
const TYPE_METRIC_VAR = /font-size|line-height|leading|(?:^|-)weight(?:-|$)/;

/** A type property set inside a utility body, with its value. */
const TYPE_PROPERTY =
  /(?:^|[;{\s])(font-size|line-height|font-weight)\s*:\s*([^;}]+)/g;

interface Failure {
  message: string;
  hint: string;
}

/** The utilities the ladder derives: name → whether it carries scaled metrics. */
export function derivedUtilities(): Map<string, "metrics" | "weight"> {
  const out = new Map<string, "metrics" | "weight">();
  for (const [role, spec] of Object.entries(TYPE_ROLES)) {
    out.set(`text-${role}`, "metrics");
    out.set(`text-${role}-compact`, "metrics");
    if (spec.weight === "token") {
      out.set(`font-${role}`, "weight");
      if ("strong" in spec && spec.strong)
        out.set(`font-${role}-strong`, "weight");
    }
  }
  return out;
}

/** Every `@utility <name> { … }` in a stylesheet, comments stripped. */
export function parseUtilities(
  css: string,
): Array<{ name: string; body: string }> {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Array<{ name: string; body: string }> = [];
  const re = /@utility\s+([\w-]+)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
    }
    out.push({ name: m[1]!, body: src.slice(re.lastIndex, i - 1) });
    re.lastIndex = i;
  }
  return out;
}

/**
 * The `<Text variant>` list the rule's message advertises: the `variants: a | b`
 * run inside its `messages: { … }` block, string concatenations joined. `null`
 * when the block or the list cannot be found.
 */
export function advertisedVariants(ruleSrc: string): {
  variants: string[];
  message: string;
} | null {
  const start = ruleSrc.indexOf("messages: {");
  const end = ruleSrc.indexOf("defaultOptions", start);
  if (start === -1 || end === -1) return null;
  const message = ruleSrc
    .slice(start, end)
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n")
    .replace(/"\s*\+\s*"/g, "");
  const list = /variants:\s*([a-z0-9 |]+)/.exec(message);
  if (!list) return null;
  const variants = list[1]!
    .split("|")
    .map((v) => v.trim())
    .filter(Boolean);
  return { variants, message };
}

const check: Check = {
  id: "type-scale:closed-role-ladder",
  description:
    "the type-scale role ladder stays closed: type-scale keys = TYPE_ROLES-derived + non-role keys, no other token group declares type metrics, every ui-kit type @utility is a derived role utility scaled by --font-scale, the no-adhoc-typography message names every <Text> variant, every role picker (tooltip, role-pick) covers exactly the ladder, every …Role / …Emphasis / …Family token declares the PICK_* vocabulary, and no TS outside text/type-scale reads a raw type var",
  exemptable: {
    [RAW_VARS]:
      "reads a raw `var(--font-size-*)` / `var(--line-height-*)` in TS, which skips --font-scale (use typeVar())",
  },
  async run(ctx): Promise<CheckResult> {
    const root = await getWorktreeRoot();
    // Every leak is reported in one run, not the first one only.
    const failures: Failure[] = [];
    const report = (message: string, hint: string): void => {
      failures.push({ message, hint });
    };

    // (1) The type-scale group's keys = the ladder's keys, exactly.
    const expected = new Set([...roleTokenKeys(), ...NON_ROLE_KEYS]);
    const actual = new Set(Object.keys(typeScaleGroup.schema));
    const extra = [...actual].filter((k) => !expected.has(k));
    const missing = [...expected].filter((k) => !actual.has(k));
    if (extra.length > 0) {
      report(
        `${TYPE_SCALE_GROUP} declares type tokens that are not a role's: ${extra.join(", ")}`,
        "The ladder is closed: a component picks an existing role (<Text variant> / text-<role>) and a theme resizes that ROLE. " +
          "If a genuinely new role is needed, add it to TYPE_ROLES in plugins/primitives/plugins/css/plugins/text/core/roles.ts " +
          `(its tokens then derive); a non-role key (like the sub-scale) goes in NON_ROLE_KEYS in ${THIS_CHECK} with a reason.`,
      );
    }
    if (missing.length > 0) {
      report(
        `${TYPE_SCALE_GROUP} is missing tokens the TYPE_ROLES ladder implies: ${missing.join(", ")}`,
        "Every role has fontSize<Role> + lineHeight<Role> (literal lengths), a token-weight role fontWeight<Role> (+ Strong), " +
          'and a role with compact: "own" its fontSize<Role>Compact / lineHeight<Role>Compact. Declare them in the group.',
      );
    }

    // (2) No other token group declares type metrics.
    const byGroup = await collectTokenGroupVars(root);
    const leaks: string[] = [];
    for (const [group, vars] of Object.entries(byGroup)) {
      if (group === TYPE_SCALE_GROUP_ID) continue;
      for (const v of vars)
        if (TYPE_METRIC_VAR.test(v)) leaks.push(`${group}: ${v}`);
    }
    if (leaks.length > 0) {
      report(
        `token groups other than type-scale declare type metrics (size / line height / weight): ${leaks.join(", ")}`,
        "Type metrics live only in the type-scale role ladder, so one theme edit and --font-scale move all of them. " +
          "Delete the token and have the component use a role (<Text variant> / text-<role>); a theme then sets that role.",
      );
    }

    // (3) Every type-setting @utility is a derived role utility, scaled.
    const derived = derivedUtilities();
    const utilities = parseUtilities(readFileSync(join(root, APP_CSS), "utf8"));
    const seen = new Set(utilities.map((u) => u.name));
    const rogue: string[] = [];
    const unscaled: string[] = [];
    for (const { name, body } of utilities) {
      const props = [...body.matchAll(TYPE_PROPERTY)];
      if (props.length === 0) continue;
      const kind = derived.get(name);
      if (!kind) {
        rogue.push(name);
        continue;
      }
      for (const [, prop, value] of props) {
        if (prop === "font-weight") continue;
        if (!/\*\s*var\(--font-scale\)/.test(value!))
          unscaled.push(`${name} (${prop})`);
      }
    }
    if (rogue.length > 0) {
      report(
        `${APP_CSS}: @utility classes set font-size / line-height / font-weight but are not role utilities: ${rogue.join(", ")}`,
        "A custom text-<name> utility is a component-named type token by another name (no lint rule sees it). " +
          "Use a role's utility (text-<role>, text-<role>-compact, font-<role>[-strong]) — the set derived from TYPE_ROLES.",
      );
    }
    const absent = [...derived.keys()].filter((n) => !seen.has(n));
    if (absent.length > 0) {
      report(
        `${APP_CSS}: TYPE_ROLES implies utilities that are not declared: ${absent.join(", ")}`,
        "Declare each as an @utility beside the other role utilities (font-size / line-height as calc(var(--…) * var(--font-scale)), with a twmerge marker).",
      );
    }
    if (unscaled.length > 0) {
      report(
        `${APP_CSS}: role utilities whose size / line height ignores --font-scale: ${unscaled.join(", ")}`,
        "Write it as calc(var(--font-size-<x>) * var(--font-scale)) (same for line-height), so the theme's one scale factor reaches it.",
      );
    }

    // (4) The lint message names every <Text> variant and the sub-scale.
    const ruleSrc = readFileSync(join(root, TYPOGRAPHY_RULE), "utf8");
    const advertised = advertisedVariants(ruleSrc) ?? {
      variants: [],
      message: "",
    };
    if (advertised.variants.length === 0) {
      report(
        `${TYPOGRAPHY_RULE}: could not find the \`variants: a | b | …\` list inside the rule's \`messages: { … }\` block`,
        `Keep the message listing "(variants: display | title | …)", or update advertisedVariants() in ${THIS_CHECK}.`,
      );
    }
    const textVariants = [...Object.keys(TYPE_ROLES), ...TEXT_TREATMENTS];
    const unnamed = textVariants.filter(
      (v) => !advertised.variants.includes(v),
    );
    const stale = advertised.variants.filter((v) => !textVariants.includes(v));
    const subscale = TYPE_SUBSCALE.map((s) => `text-${s}`).filter(
      (c) => !advertised.message.includes(c),
    );
    if (unnamed.length > 0 || stale.length > 0 || subscale.length > 0) {
      report(
        `${TYPOGRAPHY_RULE}: the adhocTypography message is out of step with the ladder — ` +
          [
            unnamed.length > 0 ? `missing variants: ${unnamed.join(", ")}` : "",
            stale.length > 0 ? `names non-variants: ${stale.join(", ")}` : "",
            subscale.length > 0
              ? `missing sub-scale: ${subscale.join(", ")}`
              : "",
          ]
            .filter(Boolean)
            .join("; "),
        "The message is what an author reads when the rule fires; list every TYPE_ROLES role and TEXT_TREATMENTS treatment, and the text-2xs / text-3xs sub-scale.",
      );
    }

    // (6) Every role picker covers exactly the ladder.
    for (const picker of ROLE_PICKERS) {
      const got = rolePickerPairs(
        readFileSync(join(root, picker.file), "utf8"),
        picker.roleVar,
      );
      const want = picker.expected();
      const missingPairs = [...want].filter((p) => !got.has(p)).sort();
      const extraPairs = [...got].filter((p) => !want.has(p)).sort();
      if (missingPairs.length > 0 || extraPairs.length > 0) {
        report(
          `${picker.file}: the ${picker.id} role picker is out of step with the ladder — ` +
            [
              missingPairs.length > 0
                ? `missing: ${missingPairs.join(", ")}`
                : "",
              extraPairs.length > 0
                ? `not the ladder's: ${extraPairs.join(", ")}`
                : "",
            ]
              .filter(Boolean)
              .join("; "),
          picker.hint,
        );
      }
    }

    // (6b) Every pick token declares exactly its axis's vocabulary.
    const pickLeaks: string[] = [];
    for (const [groupId, group] of Object.entries(
      await collectTokenGroups(root),
    )) {
      for (const [key, field] of Object.entries(group.schema)) {
        const axis = PICK_AXES.find((a) => key.endsWith(a.suffix));
        if (!axis || PICK_AXIS_EXCEPTIONS.includes(`${groupId}.${key}`))
          continue;
        const declared = field.values;
        if (
          declared === undefined ||
          declared.length !== axis.values.length ||
          declared.some((v, i) => v !== axis.values[i])
        ) {
          pickLeaks.push(
            `${groupId}.${key} (values: ${declared === undefined ? "none" : declared.join(" | ")})`,
          );
        }
      }
    }
    if (pickLeaks.length > 0) {
      report(
        `token keys ending Role / Emphasis / Family must declare values equal to PICK_RUNGS / PICK_EMPHASES / PICK_FAMILIES: ${pickLeaks.join(", ")}`,
        "Declare `values: PICK_RUNGS` (or PICK_EMPHASES / PICK_FAMILIES, from @plugins/primitives/plugins/css/plugins/text/core) on the token, so a theme cannot name a value the role-pick tables do not apply. " +
          `A key that is not a part's pick should not end in Role / Emphasis / Family; one with its own vocabulary and table goes in PICK_AXIS_EXCEPTIONS in ${THIS_CHECK} with its rule-6 picker.`,
      );
    }

    // (5) No raw type var in TS outside the ladder's owners.
    const exempt = await ctx.exempt(RAW_VARS);
    const rawVars = (
      await grepCode({
        root,
        pattern: /var\(--(?:font-size|line-height)-/,
        // ERE: the literal paren is escaped (unescaped, git rejects the pattern
        // and the check fails with its error).
        grepArg: "var\\(--(font-size|line-height)-",
        maskStrings: false,
      })
    ).filter((m) => !exempt.skips(m.path));
    if (rawVars.length > 0) {
      report(
        `raw type vars read outside the text / type-scale plugins (they skip --font-scale): ${rawVars
          .map((m) => `${m.path}:${m.line}`)
          .join(", ")}`,
        'Use typeVar("line-height-body") from @plugins/primitives/plugins/css/plugins/text/core — the same calc(var(--x) * var(--font-scale)) every role utility writes — or, for styling, a role utility. A file that must read one declares it in its plugin\'s `exempt/index.ts` (rule `type-scale:closed-role-ladder:raw-vars`).',
      );
    }

    if (failures.length === 0) return { ok: true };
    return {
      ok: false,
      message: failures.map((f, i) => `(${i + 1}) ${f.message}`).join("\n"),
      hint: failures.map((f, i) => `(${i + 1}) ${f.hint}`).join("\n"),
    };
  },
};

export default check;
