import { LOGO, logoMarkSvg } from "@plugins/ui/plugins/logo/core";
import { FONT, INK, REDUCED_MOTION } from "./style";

/** The Try it card: the logo, a "Try the demo online" button, and what the demo is. */
export function demoSvg(): string {
  const W = 1200;
  const H = 520;
  const btnW = 300;
  const BLUE = LOGO.gradient.from;
  const VIOLET = LOGO.gradient.to;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
  <radialGradient id="demo-a" cx=".18" cy="0" r=".6"><stop offset="0" stop-color="${BLUE}" stop-opacity="0.22"/><stop offset="1" stop-color="${BLUE}" stop-opacity="0"/></radialGradient>
  <radialGradient id="demo-b" cx=".85" cy=".05" r=".5"><stop offset="0" stop-color="${VIOLET}" stop-opacity="0.22"/><stop offset="1" stop-color="${VIOLET}" stop-opacity="0"/></radialGradient>
  <clipPath id="demo-clip"><rect width="${W}" height="${H}" rx="20"/></clipPath>
  <filter id="demo-sh" x="-20%" y="-50%" width="140%" height="200%"><feDropShadow dx="0" dy="6" stdDeviation="10" flood-color="${VIOLET}" flood-opacity=".35"/></filter>
</defs>
<style>
  text { ${FONT} } .b { font-size: 22px; font-weight: 600; fill: ${INK.bg}; } .c { font-size: 20px; fill: ${INK.muted}; }
  .btn { animation: breathe 3s ease-in-out infinite; transform-origin: ${W / 2}px 380px; }
  @keyframes breathe { 50% { transform: scale(1.04); } }
  ${REDUCED_MOTION}
</style>
<g clip-path="url(#demo-clip)">
  <rect width="${W}" height="${H}" fill="${INK.bg}"/>
  <rect width="${W}" height="${H}" fill="url(#demo-a)"/><rect width="${W}" height="${H}" fill="url(#demo-b)"/>
</g>
<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="20" fill="none" stroke="${INK.border}"/>
<g transform="translate(${W / 2 - 70} 110) scale(1.4)">${logoMarkSvg({ master: "full", paint: "gradient", idPrefix: "demo-logo-" })}</g>
<g class="btn" filter="url(#demo-sh)">
  <rect x="${(W - btnW) / 2}" y="350" width="${btnW}" height="60" rx="14" fill="#f3f4f6"/>
  <text x="${W / 2}" y="388" text-anchor="middle" class="b">Try the demo online  →</text>
</g>
<text x="${W / 2}" y="456" text-anchor="middle" class="c">equin, running entirely in your browser.</text>
</svg>
`;
}
