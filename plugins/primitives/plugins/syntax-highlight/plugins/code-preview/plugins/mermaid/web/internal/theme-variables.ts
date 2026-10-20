/**
 * Mermaid's `base` theme variables, read from the theme tokens in force at `el`
 * — so a diagram wears the app's palette (and its scope's theme), not mermaid's
 * own.
 *
 * Every colour goes through a 1×1 canvas: tokens may be spelled `oklch(…)` (or
 * carry alpha), which mermaid's colour maths (khroma) cannot parse, and the
 * canvas hands back the plain sRGB it actually paints. A translucent token is
 * composited over the background, as it would be on screen.
 */
export function mermaidThemeVariables(
  el: HTMLElement,
  dark: boolean,
): Record<string, string | boolean> {
  const style = getComputedStyle(el);
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("mermaid theme: no 2d canvas context");

  const raw = (token: string): string => {
    const value = style.getPropertyValue(`--${token}`).trim();
    if (!value) throw new Error(`mermaid theme: token --${token} is not set`);
    return value;
  };
  const paint = (value: string, under?: string): string => {
    ctx.clearRect(0, 0, 1, 1);
    if (under) {
      ctx.fillStyle = under;
      ctx.fillRect(0, 0, 1, 1);
    }
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `#${[r, g, b].map((c) => (c ?? 0).toString(16).padStart(2, "0")).join("")}`;
  };

  const background = paint(raw("background"));
  const color = (token: string) => paint(raw(token), background);

  const foreground = color("foreground");
  const muted = color("muted");
  const mutedForeground = color("muted-foreground");
  const border = color("border");
  const accent = color("accent");
  const card = color("card");

  return {
    darkMode: dark,
    fontFamily: style.fontFamily,
    background,
    textColor: foreground,
    primaryColor: card,
    primaryTextColor: foreground,
    primaryBorderColor: mutedForeground,
    secondaryColor: accent,
    secondaryTextColor: foreground,
    secondaryBorderColor: mutedForeground,
    tertiaryColor: muted,
    tertiaryTextColor: foreground,
    tertiaryBorderColor: border,
    lineColor: mutedForeground,
    mainBkg: card,
    nodeBorder: mutedForeground,
    clusterBkg: muted,
    clusterBorder: border,
    titleColor: foreground,
    edgeLabelBackground: background,
    noteBkgColor: accent,
    noteTextColor: foreground,
    noteBorderColor: border,
    actorBkg: card,
    actorBorder: mutedForeground,
    actorTextColor: foreground,
    actorLineColor: mutedForeground,
    signalColor: foreground,
    signalTextColor: foreground,
    labelBoxBkgColor: card,
    labelBoxBorderColor: mutedForeground,
    labelTextColor: foreground,
    loopTextColor: foreground,
    activationBkgColor: muted,
    activationBorderColor: mutedForeground,
    sequenceNumberColor: background,
  };
}
