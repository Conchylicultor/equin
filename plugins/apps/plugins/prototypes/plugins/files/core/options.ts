import { Color } from "@plugins/primitives/plugins/css/plugins/color-picker/core";

/**
 * Prototype options — the variants a prototype lets the reader flip between,
 * declared in its own `index.html`. Two kinds:
 *
 * ```html
 * <html data-palette="violet" style="--accent: #7c5cff">
 * <meta name="prototype-option" content="pane: flush | floating | soft-tray" />
 * <meta name="prototype-option" content="accent: color violet=#7c5cff | azure=#3b82f6" />
 * ```
 *
 * - **choice** — the `<meta>` lists the values, in picker order; the
 *   `data-<name>` attribute the author writes on `<html>` IS the default.
 * - **color** — a leading `color` keyword, then 0..n named suggestions
 *   (`name=<css color>`); the reader may pick any color. The default is the
 *   `--<name>` custom property in `<html style>`, and the page reads
 *   `var(--<name>)`.
 *
 * Options may be grouped: `<meta name="prototype-option-group" content="Mist">`
 * starts a group, and every option declared after it (up to the next group
 * line) belongs to it — the picker draws it as one titled section.
 *
 * Either way the page carries its default in every context — double-clicked
 * off disk, in the thumbnail render, in the app — and the app only ever
 * OVERWRITES it with the picked value (the server stamps it, see
 * `server/internal/picked-document.ts`; the canvas also sets a color live on
 * the frame's `<html>`, without a reload). The picker is drawn by the app,
 * outside the page, so a prototype contains no switcher of its own.
 *
 * Pure: the HTML read that feeds `foldOptions` is `readOptionSource`
 * (`option-source.ts`), the one HTMLRewriter pass the list, the validator and
 * the server share.
 */

/** A choice option: one of a fixed list of values. */
export interface ChoiceOption {
  kind: "choice";
  /** `palette` — also the `data-palette` attribute and the query key. */
  name: string;
  /** Every value, in picker order. At least two, all distinct. */
  values: readonly [string, string, ...string[]];
  /** The value the page's own `<html data-<name>>` carries. One of `values`. */
  default: string;
  /** The label of the group it is declared under, `null` before any group. */
  group: string | null;
}

/** One named color an agent suggests for a color option. */
export interface ColorSuggestion {
  /** `violet` — a value token (`isOptionValue`), what a pick of it stores. */
  name: string;
  /** Lowercase `#rrggbb`. */
  color: string;
}

/**
 * A color option: any opaque color, with the agent's named suggestions. Its
 * pick value is a suggestion's name or a lowercase `#rrggbb`.
 */
export interface ColorOption {
  kind: "color";
  /** `accent` — also the `--accent` custom property and the query key. */
  name: string;
  /** The agent's suggestions, in picker order (may be empty), names distinct. */
  suggestions: readonly ColorSuggestion[];
  /** The page's own `<html style="--<name>: …">`, as lowercase `#rrggbb`. */
  default: string;
  /** The label of the group it is declared under, `null` before any group. */
  group: string | null;
}

/** One option, valid against its declaration and its page's default. */
export type PrototypeOption = ChoiceOption | ColorOption;

/**
 * One `<meta name="prototype-option">` line, parsed. Syntax only — whether the
 * page carries a default for it is `foldOptions`' business, since that needs
 * the `<html>` attributes too.
 */
export type OptionDeclaration =
  | {
      kind: "choice";
      name: string;
      values: readonly [string, string, ...string[]];
    }
  | { kind: "color"; name: string; suggestions: readonly ColorSuggestion[] }
  | { kind: "malformed"; raw: string; reason: string };

/**
 * Picked values, keyed by option name: a choice option's one of its values, a
 * color option's a suggestion name or `#rrggbb`. Insertion order is
 * declaration order, which is the order they are written into a URL.
 */
export type OptionPicks = Readonly<Record<string, string>>;

/** An option name: a lowercase identifier (it becomes a `data-*` attribute). */
const NAME_RE = /^[a-z][a-z0-9-]*$/;
/** A value: lowercase letters, digits and dashes (`3-octaves` is fine). */
const VALUE_RE = /^[a-z0-9][a-z0-9-]*$/;
/** A color option's custom pick: lowercase `#rrggbb`, the one stored spelling. */
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/;
/** The query key the app's reload cache-bust already owns. */
const RESERVED_NAMES = new Set(["v"]);
/**
 * The keyword that makes a declaration a color option: `color` alone, or
 * followed by a suggestion. `mode: color | mono` stays a choice — the keyword
 * is never followed by a `|`.
 */
const COLOR_KEYWORD_RE = /^color(?:$|\s+(?=[^|\s]))/;

/**
 * Whether `name` can name an option: the grammar a declaration's name follows,
 * with the reserved `v` excluded. The one spelling of that rule outside a
 * declaration — a stored pick (`picks.ts`) is judged by it, never by a regex
 * typed out a second time.
 */
export function isOptionName(name: string): boolean {
  return NAME_RE.test(name) && !RESERVED_NAMES.has(name);
}

/** Whether `value` can be one of an option's values — see {@link isOptionName}. */
export function isOptionValue(value: string): boolean {
  return VALUE_RE.test(value);
}

/** Whether `value` is a color option's custom pick: lowercase `#rrggbb`. */
export function isHexColor(value: string): boolean {
  return HEX_COLOR_RE.test(value);
}

/**
 * Whether `value` can be stored as ANY option's pick: a value token (a choice
 * value, or a color suggestion's name) or a `#rrggbb` color.
 */
export function isPickValue(value: string): boolean {
  return isOptionValue(value) || isHexColor(value);
}

/**
 * A CSS color → the lowercase `#rrggbb` a color option stores, or the reason
 * it cannot be one. Read with the color picker's own parser (hex, `oklch()`,
 * `rgb()`, `hsl()`); a translucent color is refused — an option paints a
 * color, and `#rrggbb` is what it is stored as.
 */
export function parseOptionColor(
  css: string,
): { ok: true; hex: string } | { ok: false; reason: string } {
  const color = Color.fromCss(css);
  if (color === null) {
    return {
      ok: false,
      reason: `"${css}" is not a color (write #rrggbb, oklch(…), rgb(…) or hsl(…))`,
    };
  }
  if (color.alpha < 1) {
    return {
      ok: false,
      reason: `"${css}" is translucent — an option color is opaque`,
    };
  }
  return { ok: true, hex: color.toHex() };
}

const CHOICE_SYNTAX = '"<name>: <value> | <value>"';
const COLOR_SYNTAX = '"<name>: color <suggestion>=<color> | …"';

/**
 * Parse one `content` attribute: `palette: violet | indigo | azure`, or
 * `accent: color violet=#7c5cff | azure=#3b82f6`.
 */
export function parseOptionDeclaration(raw: string): OptionDeclaration {
  const trimmed = raw.trim();
  const malformed = (reason: string): OptionDeclaration => ({
    kind: "malformed",
    raw: trimmed,
    reason,
  });

  const colon = trimmed.indexOf(":");
  if (colon < 0) return malformed('there is no "<name>:" prefix');

  const name = trimmed.slice(0, colon).trim();
  if (name === "")
    return malformed("the option name before the colon is empty");
  if (!NAME_RE.test(name)) {
    return malformed(
      "an option name is lowercase letters, digits and dashes, starting with a letter",
    );
  }
  if (RESERVED_NAMES.has(name)) {
    return malformed(
      `"${name}" is reserved — the app uses it to reload the frame on edit`,
    );
  }

  const rest = trimmed.slice(colon + 1).trim();
  const keyword = COLOR_KEYWORD_RE.exec(rest);
  if (keyword) {
    return parseColorSuggestions(
      name,
      rest.slice(keyword[0].length),
      malformed,
    );
  }

  const values = rest.split("|").map((v) => v.trim());
  if (values.some((v) => v === "")) {
    return malformed("a value between two | is empty");
  }
  const bad = values.find((v) => !VALUE_RE.test(v));
  if (bad !== undefined) {
    return malformed(
      `"${bad}" is not a value — values are lowercase letters, digits and dashes`,
    );
  }
  const seen = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) return malformed(`"${v}" is listed twice`);
    seen.add(v);
  }
  const [first, second, ...rest2] = values;
  if (first === undefined || second === undefined) {
    return malformed("an option needs at least two values");
  }
  return { kind: "choice", name, values: [first, second, ...rest2] };
}

/** `violet=#7c5cff | azure=oklch(0.62 0.19 260)` → the suggestions. */
function parseColorSuggestions(
  name: string,
  list: string,
  malformed: (reason: string) => OptionDeclaration,
): OptionDeclaration {
  const suggestions: ColorSuggestion[] = [];
  if (list.trim() === "") return { kind: "color", name, suggestions };
  for (const part of list.split("|").map((p) => p.trim())) {
    if (part === "") return malformed("a suggestion between two | is empty");
    const eq = part.indexOf("=");
    if (eq < 0) {
      return malformed(
        `the suggestion "${part}" has no color — write it as <name>=<color>`,
      );
    }
    const label = part.slice(0, eq).trim();
    if (!VALUE_RE.test(label)) {
      return malformed(
        `"${label}" is not a suggestion name — names are lowercase letters, digits and dashes`,
      );
    }
    if (suggestions.some((s) => s.name === label)) {
      return malformed(`the suggestion "${label}" is listed twice`);
    }
    const color = parseOptionColor(part.slice(eq + 1).trim());
    if (!color.ok) {
      return malformed(`the suggestion "${label}": ${color.reason}`);
    }
    suggestions.push({ name: label, color: color.hex });
  }
  return { kind: "color", name, suggestions };
}

/**
 * What the HTML says about options, before any judgement: every
 * `<meta name="prototype-option">` content in document order, every
 * `<meta name="prototype-option-group">` with the index of the declaration it
 * precedes, the `data-*` attributes on `<html>` (keyed WITHOUT the `data-`
 * prefix) and the custom properties in its `style` (keyed WITHOUT the `--`).
 */
export interface OptionSource {
  declarations: readonly string[];
  /** Group lines: `at` is the index in `declarations` the group starts at. */
  groups: readonly { at: number; label: string }[];
  htmlData: Readonly<Record<string, string>>;
  htmlVars: Readonly<Record<string, string>>;
}

/**
 * The valid options, plus one problem detail per line that cannot be one. A
 * broken line is left out of the picker — its problem says why, on the card.
 */
export function foldOptions(source: OptionSource): {
  options: PrototypeOption[];
  problems: string[];
} {
  const options: PrototypeOption[] = [];
  const problems: string[] = [];
  let group: string | null = null;

  for (const [i, raw] of source.declarations.entries()) {
    for (const g of source.groups) {
      if (g.at !== i) continue;
      const label = g.label.trim();
      if (label === "") {
        problems.push(
          `<meta name="prototype-option-group"> has no label — write it as content="<label>", e.g. content="Layout"`,
        );
      } else group = label;
    }
    const d = parseOptionDeclaration(raw);
    if (d.kind === "malformed") {
      const syntax = COLOR_KEYWORD_RE.test(
        d.raw.slice(d.raw.indexOf(":") + 1).trim(),
      )
        ? COLOR_SYNTAX
        : `${CHOICE_SYNTAX} (or, for a color, ${COLOR_SYNTAX})`;
      problems.push(
        `<meta name="prototype-option" content="${d.raw}"> is malformed — ${d.reason}. Write it as ${syntax}`,
      );
      continue;
    }
    if (options.some((o) => o.name === d.name)) {
      problems.push(
        `the option "${d.name}" is declared twice — only the first <meta name="prototype-option"> for it is used`,
      );
      continue;
    }
    if (d.kind === "color") {
      const color = foldColorDefault(d, source);
      if (!color.ok) {
        problems.push(color.problem);
        continue;
      }
      options.push({
        kind: "color",
        name: d.name,
        suggestions: d.suggestions,
        default: color.hex,
        group,
      });
      continue;
    }
    const def = source.htmlData[d.name];
    if (def === undefined) {
      problems.push(
        `the option "${d.name}" has no default — put it on the page's own <html>, e.g. <html data-${d.name}="${d.values[0]}">, so the page renders the same off disk as in the app`,
      );
      continue;
    }
    if (!d.values.includes(def)) {
      problems.push(
        `<html data-${d.name}="${def}"> is not one of the option's values (${d.values.join(" | ")})`,
      );
      continue;
    }
    options.push({
      kind: "choice",
      name: d.name,
      values: d.values,
      default: def,
      group,
    });
  }

  return { options, problems };
}

/** A color option's default: its `--<name>` in `<html style>`, as `#rrggbb`. */
function foldColorDefault(
  d: { name: string; suggestions: readonly ColorSuggestion[] },
  source: OptionSource,
): { ok: true; hex: string } | { ok: false; problem: string } {
  const raw = source.htmlVars[d.name];
  const example = d.suggestions[0]?.color ?? "#7c5cff";
  if (raw === undefined) {
    const hint =
      source.htmlData[d.name] === undefined
        ? ""
        : ` (a color option's default is the --${d.name} custom property, not data-${d.name})`;
    return {
      ok: false,
      problem: `the color option "${d.name}" has no default — put it in the page's own <html style>, e.g. <html style="--${d.name}: ${example}">, so the page renders the same off disk as in the app${hint}`,
    };
  }
  const color = parseOptionColor(raw);
  if (!color.ok) {
    return {
      ok: false,
      problem: `<html style="--${d.name}: ${raw}"> is not the color option's default: ${color.reason}`,
    };
  }
  return { ok: true, hex: color.hex };
}

/** The suggestion named `value` of a color option, if it is one. */
function suggestionNamed(
  option: ColorOption,
  value: string,
): ColorSuggestion | undefined {
  return option.suggestions.find((s) => s.name === value);
}

/**
 * The color a color option's pick value stands for (`#rrggbb`) — a
 * suggestion's color for its name, the hex itself for a custom pick — or
 * `null` when the value is neither (a stale or foreign value).
 */
function colorOfValue(option: ColorOption, value: string): string | null {
  if (isHexColor(value)) return value;
  return suggestionNamed(option, value)?.color ?? null;
}

/**
 * The pick value that names `hex` for a color option: the first suggestion of
 * exactly that color, else the hex itself. How a color the reader dragged to
 * is stored, so landing on a suggestion reads as that suggestion.
 */
export function colorPickValue(option: ColorOption, hex: string): string {
  return option.suggestions.find((s) => s.color === hex)?.name ?? hex;
}

/** The value an option shows when nothing is picked. */
function defaultValue(option: PrototypeOption): string {
  return option.kind === "choice"
    ? option.default
    : colorPickValue(option, option.default);
}

/** Whether `value` is a valid pick of `option` — a value of the declaration. */
function isValueOf(option: PrototypeOption, value: string): boolean {
  return option.kind === "choice"
    ? option.values.includes(value)
    : colorOfValue(option, value) !== null;
}

/** Whether picking `value` shows what the page shows by itself. */
function isDefaultValue(option: PrototypeOption, value: string): boolean {
  return option.kind === "choice"
    ? value === option.default
    : colorOfValue(option, value) === option.default;
}

/**
 * Remembered picks → the ones still valid against today's declaration, minus
 * defaults (the page already carries those, and leaving them out keeps an
 * untouched prototype's URL exactly what it was).
 *
 * Dropping a stale pick is correct, not a swallowed failure: it is a remembered
 * preference for a value the author has since removed. A URL naming one is a
 * different matter — see `picksFromQuery`.
 */
export function resolvePicks(
  options: readonly PrototypeOption[],
  stored: Readonly<Record<string, string>>,
): OptionPicks {
  const picks: Record<string, string> = {};
  for (const o of options) {
    const v = stored[o.name];
    if (v !== undefined && isValueOf(o, v) && !isDefaultValue(o, v)) {
      picks[o.name] = v;
    }
  }
  return picks;
}

/**
 * The value an option shows under `picks`: the pick, else the page's default
 * (for a color option, the suggestion of the default's color when there is
 * one, else its hex).
 */
export function pickedValue(
  option: PrototypeOption,
  picks: OptionPicks,
): string {
  return picks[option.name] ?? defaultValue(option);
}

/**
 * The color a color option shows under `picks`, as `#rrggbb`: the pick's
 * color, else the page's default. `picks` are resolved (`resolvePicks`), so a
 * pick is always a value of the option.
 */
export function pickedColor(option: ColorOption, picks: OptionPicks): string {
  const v = picks[option.name];
  return (v === undefined ? null : colorOfValue(option, v)) ?? option.default;
}

/** "violet | indigo" / "color: violet=#7c5cff | azure=#3b82f6" — an option's values, for prose. */
export function describeOptionValues(option: PrototypeOption): string {
  if (option.kind === "choice") return option.values.join(" | ");
  if (option.suggestions.length === 0) return "color: any #rrggbb";
  return `color: ${option.suggestions.map((s) => `${s.name}=${s.color}`).join(" | ")}`;
}

/**
 * A request's query → picks, for the server. Every key but `v` must name a
 * declared option and every value one of its values (for a color option, a
 * suggestion's name or a `#rrggbb`, read case-insensitively and stored
 * lowercase): a URL that names anything else is a broken link and FAILS,
 * rather than quietly rendering the default and letting the reader believe
 * they are looking at the variant they asked for.
 */
export function picksFromQuery(
  options: readonly PrototypeOption[],
  search: URLSearchParams,
): { ok: true; picks: OptionPicks } | { ok: false; reason: string } {
  const picks: Record<string, string> = {};
  for (const [key, given] of search) {
    if (RESERVED_NAMES.has(key)) continue;
    const option = options.find((o) => o.name === key);
    if (!option) {
      const declared =
        options.length === 0
          ? "it declares none"
          : `it declares: ${options.map((o) => o.name).join(", ")}`;
      return {
        ok: false,
        reason: `"${key}" is not an option of this prototype (${declared})`,
      };
    }
    if (key in picks) {
      return { ok: false, reason: `"${key}" is given twice` };
    }
    const value =
      option.kind === "color" && /^#[0-9a-fA-F]{6}$/.test(given)
        ? given.toLowerCase()
        : given;
    if (!isValueOf(option, value)) {
      return {
        ok: false,
        reason:
          option.kind === "choice"
            ? `"${given}" is not a value of "${key}" (its values: ${describeOptionValues(option)})`
            : `"${given}" is not a value of the color option "${key}" (a #rrggbb color, or a suggestion: ${option.suggestions.map((s) => s.name).join(" | ") || "none declared"})`,
      };
    }
    picks[key] = value;
  }
  return { ok: true, picks };
}

/** `soft-tray` → "Soft tray", `88-keys` → "88 keys": the picker's label for a token. */
export function humanizeToken(token: string): string {
  const spaced = token.replace(/-/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * The picker's label for an option: its name humanized, without its group's
 * own prefix — `mist-code-block` under the group "Mist" is "Code block".
 */
export function optionLabel(option: PrototypeOption): string {
  if (option.group === null) return humanizeToken(option.name);
  const prefix = `${option.group
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}-`;
  return option.name.startsWith(prefix) && option.name.length > prefix.length
    ? humanizeToken(option.name.slice(prefix.length))
    : humanizeToken(option.name);
}

/** A run of consecutive options declared under one group (`null`: none). */
export interface OptionGroup {
  label: string | null;
  options: readonly PrototypeOption[];
}

/**
 * Options in picker order, cut into runs of one group each: the sections the
 * picker draws. A group's run ends at the next group line.
 */
export function groupOptions(
  options: readonly PrototypeOption[],
): OptionGroup[] {
  const groups: { label: string | null; options: PrototypeOption[] }[] = [];
  for (const o of options) {
    const last = groups.at(-1);
    if (last !== undefined && last.label === o.group) last.options.push(o);
    else groups.push({ label: o.group, options: [o] });
  }
  return groups;
}
