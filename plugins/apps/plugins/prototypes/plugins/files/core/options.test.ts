import { describe, expect, test } from "bun:test";
import {
  colorPickValue,
  describeOptionValues,
  foldOptions,
  groupOptions,
  humanizeToken,
  optionLabel,
  isOptionName,
  isOptionValue,
  parseOptionDeclaration,
  pickedValue,
  pickedColor,
  picksFromQuery,
  resolvePicks,
  type ColorOption,
  type PrototypeOption,
} from "./options";
import { readOptionSource, readPrototypeOptions } from "./option-source";
import { prototypeUrl } from "./prototypes";

// The syntax pin for `<meta name="prototype-option">`. The gallery list, the
// folder validator and the server's stamping all go through these functions,
// so the rules live here and nowhere else.

function reasonOf(raw: string): string {
  const d = parseOptionDeclaration(raw);
  if (d.kind !== "malformed") throw new Error(`expected malformed: ${raw}`);
  return d.reason;
}

describe("parseOptionDeclaration", () => {
  test("a declaration, whitespace ignored", () => {
    expect(
      parseOptionDeclaration("  palette :violet|  indigo | azure "),
    ).toEqual({
      kind: "choice",
      name: "palette",
      values: ["violet", "indigo", "azure"],
    });
  });

  test("values may start with a digit", () => {
    expect(parseOptionDeclaration("keys: 3-octaves | 88-keys")).toEqual({
      kind: "choice",
      name: "keys",
      values: ["3-octaves", "88-keys"],
    });
  });

  test("every malformed shape says why", () => {
    expect(reasonOf("palette violet | azure")).toContain('"<name>:"');
    expect(reasonOf(": a | b")).toContain("empty");
    expect(reasonOf("Palette: a | b")).toContain("lowercase");
    expect(reasonOf("3d: a | b")).toContain("starting with a letter");
    expect(reasonOf("v: a | b")).toContain("reserved");
    expect(reasonOf("p: a || b")).toContain("empty");
    expect(reasonOf("p: a | Soft tray")).toContain('"Soft tray"');
    expect(reasonOf("p: a | b | a")).toContain('"a" is listed twice');
    expect(reasonOf("p: only")).toContain("at least two");
    expect(reasonOf("")).toContain('"<name>:"');
  });
});

describe("isOptionName / isOptionValue", () => {
  test("the declaration's grammar, v reserved", () => {
    for (const ok of ["palette", "pane-style", "p2"]) {
      expect(isOptionName(ok)).toBe(true);
    }
    for (const bad of ["v", "Palette", "3d", "-x", "", "a b", "a_b"]) {
      expect(isOptionName(bad)).toBe(false);
    }
    for (const ok of ["azure", "3-octaves", "88-keys"]) {
      expect(isOptionValue(ok)).toBe(true);
    }
    for (const bad of ["Azure", "-x", "", "soft tray", "a_b"]) {
      expect(isOptionValue(bad)).toBe(false);
    }
  });

  test("agrees with parseOptionDeclaration", () => {
    expect(parseOptionDeclaration("v: a | b").kind).toBe("malformed");
    expect(isOptionName("v")).toBe(false);
    expect(parseOptionDeclaration("keys: 3-octaves | 88-keys").kind).toBe(
      "choice",
    );
    expect(isOptionValue("3-octaves")).toBe(true);
  });
});

describe("foldOptions", () => {
  test("the default is the <html data-*> attribute", () => {
    const { options, problems } = foldOptions({
      groups: [],
      declarations: ["pane: flush | floating", "palette: violet | azure"],
      htmlData: { pane: "floating", palette: "violet", other: "x" },
      htmlVars: {},
    });
    expect(problems).toEqual([]);
    expect(options).toEqual([
      {
        kind: "choice",
        name: "pane",
        values: ["flush", "floating"],
        default: "floating",
        group: null,
      },
      {
        kind: "choice",
        name: "palette",
        values: ["violet", "azure"],
        default: "violet",
        group: null,
      },
    ]);
  });

  test("a broken line is dropped and reported", () => {
    const { options, problems } = foldOptions({
      groups: [],
      declarations: [
        "pane: flush | floating",
        "pane: a | b",
        "palette: violet | azure",
        "density: cozy | compact",
        "nonsense",
      ],
      htmlData: { pane: "flush", palette: "teal" },
      htmlVars: {},
    });
    expect(options.map((o) => o.name)).toEqual(["pane"]);
    expect(problems).toHaveLength(4);
    expect(problems[0]).toContain("declared twice");
    expect(problems[1]).toContain('<html data-palette="teal">');
    expect(problems[2]).toContain('<html data-density="cozy">');
    expect(problems[3]).toContain("malformed");
  });
});

const PANE: PrototypeOption = {
  kind: "choice",
  name: "pane",
  values: ["flush", "floating", "soft-tray"],
  default: "flush",
  group: null,
};
const PALETTE: PrototypeOption = {
  kind: "choice",
  name: "palette",
  values: ["violet", "azure"],
  default: "violet",
  group: null,
};

describe("resolvePicks", () => {
  test("keeps valid non-default picks, in declaration order", () => {
    expect(
      Object.entries(
        resolvePicks([PANE, PALETTE], { palette: "azure", pane: "soft-tray" }),
      ),
    ).toEqual([
      ["pane", "soft-tray"],
      ["palette", "azure"],
    ]);
  });

  test("drops defaults, unknown options and stale values", () => {
    expect(
      resolvePicks([PANE, PALETTE], {
        pane: "flush",
        palette: "teal",
        gone: "x",
      }),
    ).toEqual({});
  });

  test("pickedValue falls back to the default", () => {
    expect(pickedValue(PANE, {})).toBe("flush");
    expect(pickedValue(PANE, { pane: "floating" })).toBe("floating");
  });
});

describe("picksFromQuery", () => {
  test("reads declared picks and ignores the cache-bust", () => {
    expect(
      picksFromQuery(
        [PANE, PALETTE],
        new URLSearchParams("v=12&palette=azure"),
      ),
    ).toEqual({ ok: true, picks: { palette: "azure" } });
  });

  test("fails on anything undeclared", () => {
    const bad = (qs: string, options = [PANE, PALETTE]) => {
      const r = picksFromQuery(options, new URLSearchParams(qs));
      if (r.ok) throw new Error(`expected failure: ${qs}`);
      return r.reason;
    };
    expect(bad("palette=teal")).toContain("violet | azure");
    expect(bad("theme=dark")).toContain("it declares: pane, palette");
    expect(bad("theme=dark", [])).toContain("it declares none");
    expect(bad("palette=azure&palette=violet")).toContain("twice");
  });

  test("round-trips through prototypeUrl", () => {
    const url = prototypeUrl("proto-1-abcd", {
      v: "a1b2c3",
      picks: resolvePicks([PANE, PALETTE], {
        palette: "azure",
        pane: "soft-tray",
      }),
    });
    expect(url).toBe(
      "/api/prototypes/proto-1-abcd/index.html?v=a1b2c3&pane=soft-tray&palette=azure",
    );
    expect(
      picksFromQuery([PANE, PALETTE], new URL(url, "http://x").searchParams),
    ).toEqual({ ok: true, picks: { pane: "soft-tray", palette: "azure" } });
  });

  test("an untouched prototype keeps its plain URL", () => {
    expect(prototypeUrl("p", { v: "a1b2c3", picks: {} })).toBe(
      "/api/prototypes/p/index.html?v=a1b2c3",
    );
    expect(prototypeUrl("p")).toBe("/api/prototypes/p/index.html");
  });
});

describe("readOptionSource", () => {
  test("reads the <html> data attributes and every option line, decoded", async () => {
    const html = `<!doctype html><html lang="en" data-pane="flush" data-palette="azure">
      <head>
        <meta name="prototype-option" content="pane: flush | floating" />
        <meta name="description" content="x" />
        <meta name="prototype-option" content="palette: violet &#124; azure" />
      </head><body></body></html>`;
    expect(await readOptionSource(html)).toEqual({
      groups: [],
      declarations: ["pane: flush | floating", "palette: violet | azure"],
      htmlData: { pane: "flush", palette: "azure" },
      htmlVars: {},
    });
    expect((await readPrototypeOptions(html)).options).toEqual([
      {
        kind: "choice",
        name: "pane",
        values: ["flush", "floating"],
        default: "flush",
        group: null,
      },
      {
        kind: "choice",
        name: "palette",
        values: ["violet", "azure"],
        default: "azure",
        group: null,
      },
    ]);
  });

  test("a page with no options declares none", async () => {
    expect(
      await readPrototypeOptions("<html><head><title>x</title></head></html>"),
    ).toEqual({ options: [], problems: [] });
  });
});

// ── Color options ──────────────────────────────────────────────────────────

const ACCENT: ColorOption = {
  kind: "color",
  name: "accent",
  suggestions: [
    { name: "violet", color: "#7c5cff" },
    { name: "azure", color: "#3b82f6" },
  ],
  default: "#7c5cff",
  group: null,
};

describe("color declarations", () => {
  test("a color keyword, then name=<css color> suggestions", () => {
    expect(
      parseOptionDeclaration(
        "accent: color violet=#7C5CFF | azure = oklch(0.623 0.188 259.8) | mint=hsl(160 84% 39%)",
      ),
    ).toEqual({
      kind: "color",
      name: "accent",
      suggestions: [
        { name: "violet", color: "#7c5cff" },
        { name: "azure", color: "#3b82f6" },
        { name: "mint", color: "#10b77f" },
      ],
    });
  });

  test("no suggestions is a color option too", () => {
    expect(parseOptionDeclaration("accent: color")).toEqual({
      kind: "color",
      name: "accent",
      suggestions: [],
    });
  });

  test("a value named color stays a choice", () => {
    expect(parseOptionDeclaration("mode: color | mono")).toEqual({
      kind: "choice",
      name: "mode",
      values: ["color", "mono"],
    });
    expect(parseOptionDeclaration("mode: colorful | mono").kind).toBe("choice");
  });

  test("every malformed suggestion says why", () => {
    expect(reasonOf("accent: color violet")).toContain("has no color");
    expect(reasonOf("accent: color Violet=#7c5cff")).toContain(
      "not a suggestion name",
    );
    expect(reasonOf("accent: color a=#7c5cff | a=#3b82f6")).toContain(
      "listed twice",
    );
    expect(reasonOf("accent: color a=var(--x)")).toContain("not a color");
    expect(reasonOf("accent: color a=#7c5cff80")).toContain("translucent");
    expect(reasonOf("accent: color a=#7c5cff || b=#000000")).toContain("empty");
  });
});

describe("color defaults", () => {
  test("the default is --<name> in <html style>, normalised to #rrggbb", () => {
    const { options, problems } = foldOptions({
      groups: [],
      declarations: ["accent: color violet=#7c5cff | azure=#3b82f6"],
      htmlData: {},
      htmlVars: { accent: "oklch(0.623 0.188 259.8)" },
    });
    expect(problems).toEqual([]);
    expect(options).toEqual([{ ...ACCENT, default: "#3b82f6" }]);
  });

  test("a missing or unreadable default is a problem, with a hint for data-*", () => {
    const { options, problems } = foldOptions({
      groups: [],
      declarations: [
        "accent: color violet=#7c5cff",
        "surface: color",
        "ink: color",
      ],
      htmlData: { surface: "white" },
      htmlVars: { ink: "calc(1px)" },
    });
    expect(options).toEqual([]);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toContain('<html style="--accent: #7c5cff">');
    expect(problems[1]).toContain("not data-surface");
    expect(problems[2]).toContain('<html style="--ink: calc(1px)">');
  });

  test("a malformed color line names the color syntax", () => {
    const { problems } = foldOptions({
      groups: [],
      declarations: ["accent: color violet"],
      htmlData: {},
      htmlVars: {},
    });
    expect(problems[0]).toContain("color <suggestion>=<color>");
  });

  test("readOptionSource reads the first <html>'s custom properties", async () => {
    const html = `<html style="color: red; --accent: #3B82F6; font-family: &quot;a;b&quot;">
      <head><meta name="prototype-option" content="accent: color violet=#7c5cff | azure=#3b82f6" /></head>
      <body><html style="--accent: #000000"></html></body></html>`;
    expect((await readOptionSource(html)).htmlVars).toEqual({
      accent: "#3B82F6",
    });
    expect((await readPrototypeOptions(html)).options).toEqual([
      { ...ACCENT, default: "#3b82f6" },
    ]);
  });
});

describe("color picks", () => {
  test("a suggestion name or a #rrggbb; the default's color is dropped", () => {
    expect(resolvePicks([ACCENT], { accent: "azure" })).toEqual({
      accent: "azure",
    });
    expect(resolvePicks([ACCENT], { accent: "#10b981" })).toEqual({
      accent: "#10b981",
    });
    expect(resolvePicks([ACCENT], { accent: "violet" })).toEqual({});
    expect(resolvePicks([ACCENT], { accent: "#7c5cff" })).toEqual({});
    expect(resolvePicks([ACCENT], { accent: "teal" })).toEqual({});
  });

  test("pickedValue / pickedColor", () => {
    expect(pickedValue(ACCENT, {})).toBe("violet");
    expect(pickedColor(ACCENT, {})).toBe("#7c5cff");
    expect(pickedValue(ACCENT, { accent: "azure" })).toBe("azure");
    expect(pickedColor(ACCENT, { accent: "azure" })).toBe("#3b82f6");
    expect(pickedColor(ACCENT, { accent: "#10b981" })).toBe("#10b981");
    // A default no suggestion carries reads as its hex.
    const custom = { ...ACCENT, default: "#222222" };
    expect(pickedValue(custom, {})).toBe("#222222");
  });

  test("colorPickValue names a suggestion's color by its name", () => {
    expect(colorPickValue(ACCENT, "#3b82f6")).toBe("azure");
    expect(colorPickValue(ACCENT, "#3b82f7")).toBe("#3b82f7");
  });

  test("describeOptionValues", () => {
    expect(describeOptionValues(PANE)).toBe("flush | floating | soft-tray");
    expect(describeOptionValues(ACCENT)).toBe(
      "color: violet=#7c5cff | azure=#3b82f6",
    );
    expect(describeOptionValues({ ...ACCENT, suggestions: [] })).toBe(
      "color: any #rrggbb",
    );
  });

  test("the query takes a name or %23rrggbb (any case, stored lowercase)", () => {
    expect(
      picksFromQuery([PANE, ACCENT], new URLSearchParams("accent=%233B82F6")),
    ).toEqual({ ok: true, picks: { accent: "#3b82f6" } });
    expect(
      picksFromQuery([ACCENT], new URLSearchParams("accent=azure")),
    ).toEqual({ ok: true, picks: { accent: "azure" } });
    for (const qs of ["accent=teal", "accent=%23abc", "accent=red"]) {
      const r = picksFromQuery([ACCENT], new URLSearchParams(qs));
      expect(r.ok).toBe(false);
    }
  });

  test("round-trips through prototypeUrl as %23rrggbb", () => {
    const picks = resolvePicks([PANE, ACCENT], {
      accent: "#10b981",
      pane: "floating",
    });
    const url = prototypeUrl("proto-1-abcd", { v: "2", picks });
    expect(url).toBe(
      "/api/prototypes/proto-1-abcd/index.html?v=2&pane=floating&accent=%2310b981",
    );
    expect(
      picksFromQuery([PANE, ACCENT], new URL(url, "http://x").searchParams),
    ).toEqual({ ok: true, picks: { pane: "floating", accent: "#10b981" } });
  });
});

describe("humanizeToken", () => {
  test("dashes become spaces, first letter capitalised", () => {
    expect(humanizeToken("soft-tray")).toBe("Soft tray");
    expect(humanizeToken("88-keys")).toBe("88 keys");
    expect(humanizeToken("azure")).toBe("Azure");
  });
});

describe("option groups", () => {
  const html = `<html data-pane="flush" data-mist-lead="icon" data-mist-code-block="12px" data-icons="lucide">
<meta name="prototype-option" content="pane: flush | floating" />
<meta name="prototype-option-group" content="Mist" />
<meta name="prototype-option" content="mist-lead: icon | status" />
<meta name="prototype-option" content="mist-code-block: 12px | 13px" />
<meta name="prototype-option-group" content="Chrome" />
<meta name="prototype-option" content="icons: lucide | material" />
</html>`;

  test("a group line puts every following option under it", async () => {
    const { options, problems } = await readPrototypeOptions(html);
    expect(problems).toEqual([]);
    expect(options.map((o) => [o.name, o.group])).toEqual([
      ["pane", null],
      ["mist-lead", "Mist"],
      ["mist-code-block", "Mist"],
      ["icons", "Chrome"],
    ]);
    expect(
      groupOptions(options).map((g) => [g.label, g.options.length]),
    ).toEqual([
      [null, 1],
      ["Mist", 2],
      ["Chrome", 1],
    ]);
  });

  test("a grouped option's label drops the group's prefix", async () => {
    const { options } = await readPrototypeOptions(html);
    expect(options.map(optionLabel)).toEqual([
      "Pane",
      "Lead",
      "Code block",
      "Icons",
    ]);
  });

  test("a group line without a label is a problem and starts no group", () => {
    const { options, problems } = foldOptions({
      groups: [
        { at: 0, label: "Layout" },
        { at: 1, label: "  " },
      ],
      declarations: ["pane: flush | floating", "density: cozy | compact"],
      htmlData: { pane: "flush", density: "cozy" },
      htmlVars: {},
    });
    expect(options.map((o) => o.group)).toEqual(["Layout", "Layout"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("has no label");
  });
});
