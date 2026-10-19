/**
 * The note layer: ONE custom Mesh for ALL notes — 4 vertices / 6 indices per
 * note, a single draw call, uint32 indices (a dense MIDI can exceed the 16k
 * notes that would overflow uint16).
 *
 * Why a mesh and not Graphics/Sprites: the whole point of the GL rewrite is
 * that resize must be O(1), not O(notes). Vertices are authored ONCE per score
 * in AUTHORED space — X in key-fractions (0..1) and Y in authored seconds,
 * exactly the {@link NoteVisual} contract from `geometry.ts` — and the parent
 * container's transform maps them to pixels (`scale = (laneWidth,
 * PX_PER_SECOND)`). A lane resize changes one container scale plus two shader
 * uniforms; the buffers never re-upload.
 *
 * Y-SIGN CONVENTION: quads are authored at y = -seconds (top = -y1Sec,
 * bottom = -y0Sec) with a POSITIVE container scale.y — the same content-space
 * convention as `geometry.ts`'s `beatToY` (y = -seconds × pxPerSec), so the
 * canvas and the DOM overlays share one formula and land pixel-exact.
 *
 * Rounded corners and the inter-note gap are computed in SCREEN PIXELS inside
 * the fragment shader (an SDF rounded-box) from the `uScale`/`uDpr` uniforms —
 * resolution- and DPR-independent with zero per-note CPU work. The fill is FLAT
 * (Synthesia-style): the white-key / black-key shade is baked into the vertex
 * color upstream (`NoteVisual.fillExpr`), so the shader just fills it. This
 * replaces the DOM version's `rounded-sm border shadow-sm` + the `w-1/h-1`
 * inset.
 *
 * ONE shader pair carries BOTH looks behind the `uSketch` flag — the flat bar
 * above, and the sketch look's hand-drawn pen (the same SDF, displaced by seeded
 * fbm and stroked). Not two `Shader` objects: that would be four sources to keep
 * in agreement instead of two, a pipeline compile the first time a user toggles,
 * and two shaders sharing one `UniformGroup` to `destroy()` carefully. The flat
 * path returns before a single instruction of the pen runs.
 *
 * The shader is authored twice (GLSL for WebGL, WGSL for WebGPU — Pixi v8's
 * dual-backend requirement) and the two sources are kept structurally parallel,
 * statement for statement, so a reader can diff them by eye; that discipline is
 * the only thing limiting drift between them.
 */
import {
  Buffer,
  BufferUsage,
  Geometry,
  Mesh,
  Shader,
  UniformGroup,
} from "pixi.js";
import type { SonataLookStyle } from "@plugins/apps/plugins/sonata/plugins/look/core";
import { PX_PER_SECOND, type NoteVisual } from "../../components/geometry";

// --- shaders -------------------------------------------------------------------
//
// Vertex: standard Pixi v8 mesh transform (projection × world × local) with the
// quad's corner UV, authored size, and color passed through. Pixi auto-binds
// `uProjectionMatrix`/`uWorldTransformMatrix` (globals) and `uTransformMatrix`
// (local) for GL; for WGSL the `globalUniforms`/`localUniforms` binding NAMES at
// groups 0/1 are load-bearing — Pixi's mesh pipe auto-assigns those bind groups
// only when the reflected layout declares them.
//
// The vertex stage also carries the SKETCH look's two preparations, both exact
// no-ops under the digital looks (where uMargin is 0): it hashes the note's own seed,
// and it grows the quad by uMargin CSS px per side so the pen may write outside
// the note box. Neither costs a byte of geometry — see the comments in-shader.
//
// Fragment: maps the corner UV to a position in CSS pixels (sizePx = aSize ×
// uScale), shrinks the box by 0.5px per side (the DOM drew notes at w-1/h-1 — a
// 1px gap between adjacent notes), rounds corners at min(4px, half the min
// dimension), fills FLAT with the (already-shaded) vertex color, and
// anti-aliases over one PHYSICAL pixel (CSS px × 1/uDpr). Output is
// premultiplied alpha (Pixi's blend convention). Under the sketch look the same
// SDF is instead displaced by seeded fbm and drawn with a pen — one branch on
// uSketch, taken after the flat path has already returned.

const GLSL_VERTEX = /* glsl */ `#version 300 es
precision highp float;

in vec2 aPosition;
in vec2 aLocal;
in vec2 aSize;
in vec4 aColor;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;

uniform vec2 uScale;
uniform float uMargin;

out vec2 vLocal;
out vec2 vSize;
out vec4 vColor;
out float vSeed;

// The SEED hash. Deliberately not the fragment's \`hash21\`, which is tuned for
// the pen's noise lattice and only ever sees small numbers: its first step
// multiplies by ~456, and a note 10 minutes into a score quantizes to ~-77000,
// so that product lands where an f32's ulp exceeds 1 and \`fract\` returns a
// constant — every note in a key column would then draw the SAME wobble. This is
// Dave Hoskins' hash12, whose small multiplier keeps the product resolvable, on
// an input first wrapped onto a bounded torus so the guarantee does not decay
// with score length at all. Measured on-GPU, seeds stay as varied 10 hours in as
// at bar 1. The wrap's period is 512s of music on one key — two notes that far
// apart sharing a wobble is not something a lane showing a few seconds can show.
float seedHash(vec2 p) {
  p = p - 65536.0 * floor(p / 65536.0);
  vec3 q = fract(p.xyx * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

void main() {
  // PER-NOTE SEED — hashed HERE, in the vertex stage, and interpolated as a
  // plain scalar. \`aPosition - aLocal * aSize\` recovers the note's authored
  // top-left from any of its four corners (aLocal is exactly 0/1, and aSize is
  // written identically to all four vertices), so every vertex hashes the same
  // number and the varying is constant across the quad.
  //
  // Hashing this per-FRAGMENT instead turns every note into TV static, for a
  // reason that does not show up in the algebra: the recovery is exact in real
  // arithmetic but not in f32 — the bottom corners compute \`yBottom - hSec\`, so
  // a few minutes into a score the recovered origin drifts ~1e-5 between the top
  // and the bottom of the same note, and a discontinuous hash spreads that drift
  // over the full 0..1 range, per pixel. Quantizing first onto a grid orders of
  // magnitude coarser than the drift (yet still unique per key column and onset)
  // is what makes the four corners agree — the quantum is 1/1024 of the lane's
  // width and 1/128 s — and hashing in the vertex stage is what keeps them
  // agreeing.
  //
  // Deliberately NOT \`flat\`: GLSL ES takes the last provoking vertex and WGSL
  // the first, so a flat varying seams down the quad's diagonal on one backend
  // and not the other. An interpolated constant is the same value on both.
  vec2 origin = aPosition - aLocal * aSize;
  vSeed = seedHash(floor(origin * vec2(1024.0, 128.0) + 0.5));

  // MARGIN — grow the quad by uMargin CSS px on every side, so the pen can write
  // outside the note box instead of being sliced flat at it. \`aLocal * 2 - 1\` is
  // -1 at the quad's min corner and +1 at its max on both axes; the container's
  // scale.y is POSITIVE (see the Y-sign convention above), so authored +y is the
  // same direction aLocal.y = 1 lies in and this grows outward on screen with no
  // per-axis special case.
  //
  // Both divisions are guarded, and that guard is not defensive noise: unguarded,
  // a zero-height grace note computes 0/0 and NaNs its whole quad out of
  // existence — in BOTH looks, because uMargin = 0 does not save you from 0/0.
  // Guarded, digital is an exact no-op: 0 / positive × ±1 is 0.
  vec2 outward = aLocal * 2.0 - 1.0;
  vec2 position = aPosition + outward * (uMargin / max(uScale, vec2(1e-6)));

  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(position, 1.0)).xy, 0.0, 1.0);
  // vLocal is stretched by the same margin so the fragment's
  // p = (vLocal - 0.5) * sizePx keeps measuring CSS px from the note's centre.
  // vSize stays the UNEXPANDED note size, so the SDF box itself is untouched.
  vLocal = aLocal + outward * (uMargin / max(aSize * uScale, vec2(1e-6)));
  vSize = aSize;
  vColor = aColor;
}
`;

const GLSL_FRAGMENT = /* glsl */ `#version 300 es
// highp, not mediump. The pen's hash does fract(p * vec2(123.34, 456.21)) on a
// quantized note origin, and at fp16 that product has no bits left to fract —
// every note would hash to the same mush. This raises the DIGITAL path too:
// identical on desktop (where mediump already is 32-bit) and strictly more
// accurate on mobile, where the SDF corner math was the thing losing precision.
precision highp float;

in vec2 vLocal;
in vec2 vSize;
in vec4 vColor;
in float vSeed;

uniform vec2 uScale;
uniform float uDpr;
uniform float uSketch;
uniform vec4 uPen;    // wobble px | grain 1/px | stroke px | wash
uniform vec4 uPaper;  // paper rgb (linear 0..1) | hatch
uniform vec2 uShape;  // inset px per side | corner radius px

out vec4 finalColor;

// The pen's noise: value noise over a 3-octave fbm, seeded per note. Cheap on
// purpose — it runs per fragment over every visible bar.
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float e = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, e, u.x), u.y);
}
float fbm(vec2 p) {
  return 0.60 * vnoise(p)
       + 0.28 * vnoise(p * 2.07 + 11.7)
       + 0.12 * vnoise(p * 4.13 + 3.1);
}

void main() {
  vec2 sizePx = vSize * uScale;
  // The look's inset per side (0.5px = a 1px gap between adjacent notes, the
  // DOM's w-1/h-1), capped at a tenth of the note's width so a narrow
  // black-key note keeps its body — but never below that 1px gap. Clamped so
  // sub-pixel notes keep a visible ~1px core instead of vanishing.
  float inset = min(uShape.x, max(0.5, 0.1 * sizePx.x));
  vec2 halfPx = max(0.5 * sizePx - inset, vec2(0.5));
  // Rounded pill corners, at the look's radius.
  float radius = min(uShape.y, min(halfPx.x, halfPx.y));
  // In CSS px from the note's centre. Reaches past ±halfPx under the sketch
  // look, where the vertex stage grew the quad by uMargin.
  vec2 p = (vLocal - 0.5) * sizePx;
  // SDF rounded box, in CSS px (negative inside).
  vec2 q = abs(p) - (halfPx - vec2(radius));
  float d = length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - radius;
  // One physical pixel of AA: adjacent fragments differ by 1/uDpr CSS px.
  float aa = 0.6 / uDpr;

  if (uSketch < 0.5) {
    // Flat fill: solid Synthesia note color (the white-key / black-key shade is
    // baked into vColor upstream) — no gradient, bevel, or rim. Literally the
    // same three lines as before the sketch look existed, and reached before a
    // single instruction of it runs.
    float coverage = 1.0 - smoothstep(-aa, aa, d);
    float alpha = vColor.a * coverage;
    finalColor = vec4(vColor.rgb * alpha, alpha);
    return;
  }

  // --- the pen ----------------------------------------------------------------
  // Everything below is a function of the note's OWN local coordinates and its
  // seed — never of screen position. That is what keeps the ink riding with each
  // note as the lane scrolls instead of crawling underneath it.
  //
  // Displace the SDF: the drawn edge is the straight one, wobbled.
  vec2 np = p * uPen.y + vec2(vSeed * 37.0, vSeed * 91.0);
  float ds = d
    + (fbm(np) - 0.5) * 2.0 * uPen.x
    + (fbm(np * 2.9 + 5.0) - 0.5) * 2.0 * uPen.x * 0.35;

  // Pen pressure — the line thins and thickens as it travels.
  float pressure = 0.55 + 0.75 * fbm(p * 0.09 + vSeed * 13.0);
  float w = uPen.z * pressure * 0.5;

  // Every smoothstep here runs low→high. The prototype wrote several of them
  // reversed (edge0 > edge1) to flip the ramp; that is undefined in BOTH GLSL ES
  // and WGSL, so each one is expressed as 1 - smoothstep instead.
  float ink = 1.0 - smoothstep(w - aa, w + aa, abs(ds));
  float inside = 1.0 - smoothstep(-aa, aa, ds);
  // A lighter second pass just outside — the stroke of a hand that went round
  // twice. This is what needs the quad's margin; it lands outside the note box.
  float ghost =
    (1.0 - smoothstep(w * 1.1, w * 2.6 + aa, abs(ds + uPen.z * 0.8))) * 0.22;

  // The ink is the note's own colour driven toward pencil-black, so two tracks
  // stay as distinguishable as they are today; the body is a wash of the same
  // colour, kept well clear of the paper or the note stops reading as a note.
  vec3 inkColor = mix(vColor.rgb * 0.42, vec3(0.10, 0.09, 0.08), 0.28);
  vec3 fill = mix(uPaper.rgb, vColor.rgb, 0.35 + 0.65 * uPen.w);

  // A crayon leaves more pigment where the hand pressed: shade the body rather
  // than filling it flat. Hatching is parallel strokes at ~35°, broken up by the
  // same noise.
  float tone = 0.86 + 0.20 * fbm(p * 0.11 + vSeed * 5.0);
  float hv = sin((p.x * 0.7 + p.y) * 0.55 + fbm(p * 0.2) * 3.0);
  float hatch = smoothstep(0.25, 0.9, hv) * uPaper.w * inside;

  float bodyA = inside * (0.52 + 0.48 * uPen.w);
  vec3 body = mix(fill * tone, inkColor, hatch * 0.65);

  float edge = clamp(max(ink, ghost * 1.4), 0.0, 1.0);
  // vColor.a is the note's velocity-driven alpha, exactly as in the flat path:
  // the pen changes how a note is drawn, never how loud it reads.
  float alpha = max(bodyA, max(ink, ghost)) * vColor.a;
  finalColor = vec4(mix(body, inkColor, edge) * alpha, alpha);
}
`;

const WGSL_SOURCE = /* wgsl */ `
struct GlobalUniforms {
  uProjectionMatrix: mat3x3<f32>,
  uWorldTransformMatrix: mat3x3<f32>,
  uWorldColorAlpha: vec4<f32>,
  uResolution: vec2<f32>,
}

struct LocalUniforms {
  uTransformMatrix: mat3x3<f32>,
  uColor: vec4<f32>,
  uRound: f32,
}

// FIELD ORDER MUST MATCH the UniformGroup below, field for field: Pixi derives
// the WebGPU UBO offsets from that declaration order using exactly these WGSL
// alignment rules, so the two agree only as long as they are spelled the same.
// A mismatch is silent and WebGPU-only.
struct NoteUniforms {
  uScale: vec2<f32>,
  uDpr: f32,
  uSketch: f32,
  uMargin: f32,
  uPen: vec4<f32>,   // wobble px | grain 1/px | stroke px | wash
  uPaper: vec4<f32>, // paper rgb (linear 0..1) | hatch
  uShape: vec2<f32>, // inset px per side | corner radius px
}

@group(0) @binding(0) var<uniform> globalUniforms: GlobalUniforms;
@group(1) @binding(0) var<uniform> localUniforms: LocalUniforms;
@group(2) @binding(0) var<uniform> noteUniforms: NoteUniforms;

struct VsOut {
  @builtin(position) position: vec4<f32>,
  @location(0) vLocal: vec2<f32>,
  @location(1) vSize: vec2<f32>,
  @location(2) vColor: vec4<f32>,
  // Interpolated, NOT @interpolate(flat): WGSL takes the FIRST provoking vertex
  // where GLSL ES takes the last, so a flat varying would seam down the quad's
  // diagonal on one backend and not the other. All four vertices write the same
  // value, so interpolating it is constant across the quad on both.
  @location(3) vSeed: f32,
}

// The SEED hash (vertex stage). Deliberately not hash21 below, which only ever
// sees the pen's small noise-lattice coordinates: hash21's first step multiplies
// by ~456, and a note 10 minutes into a score quantizes to ~-77000, where an
// f32's ulp exceeds 1 and fract() returns a constant — every note in a key
// column would draw the SAME wobble. Dave Hoskins' hash12, on an input wrapped
// onto a bounded torus first, so the variety does not decay with score length.
fn seedHash(origin: vec2<f32>) -> f32 {
  let p = origin - 65536.0 * floor(origin / 65536.0);
  var q = fract(p.xyx * 0.1031);
  q = q + vec3<f32>(dot(q, q.yzx + vec3<f32>(33.33)));
  return fract((q.x + q.y) * q.z);
}

// The pen's noise (fragment stage): value noise over a 3-octave fbm, seeded per
// note. GLSL's implicit vector/scalar mixing is spelled out here.
fn hash21(seed: vec2<f32>) -> f32 {
  var p = fract(seed * vec2<f32>(123.34, 456.21));
  p = p + vec2<f32>(dot(p, p + vec2<f32>(45.32)));
  return fract(p.x * p.y);
}
fn vnoise(pos: vec2<f32>) -> f32 {
  let i = floor(pos);
  let f = fract(pos);
  let u = f * f * (3.0 - 2.0 * f);
  let a = hash21(i);
  let b = hash21(i + vec2<f32>(1.0, 0.0));
  let c = hash21(i + vec2<f32>(0.0, 1.0));
  let e = hash21(i + vec2<f32>(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, e, u.x), u.y);
}
fn fbm(pos: vec2<f32>) -> f32 {
  return 0.60 * vnoise(pos)
       + 0.28 * vnoise(pos * 2.07 + 11.7)
       + 0.12 * vnoise(pos * 4.13 + 3.1);
}

@vertex
fn vsMain(
  @location(0) aPosition: vec2<f32>,
  @location(1) aLocal: vec2<f32>,
  @location(2) aSize: vec2<f32>,
  @location(3) aColor: vec4<f32>,
) -> VsOut {
  var o: VsOut;
  // Aliased so the body below reads token-for-token like its GLSL twin, which is
  // the only thing keeping the two hand-authored sources diffable by eye.
  let uScale = noteUniforms.uScale;
  let uMargin = noteUniforms.uMargin;

  // PER-NOTE SEED — hashed HERE, in the vertex stage (see the GLSL vertex source
  // for the full why): the origin recovery is exact in real arithmetic but not
  // in f32, so hashing it per fragment renders every note as TV static.
  let origin = aPosition - aLocal * aSize;
  o.vSeed = seedHash(floor(origin * vec2<f32>(1024.0, 128.0) + vec2<f32>(0.5)));

  // MARGIN — grow the quad by uMargin CSS px per side so the pen may write
  // outside the note box. Guarded divisions: unguarded, a zero-height grace note
  // computes 0/0 and NaNs its quad out in BOTH looks. uMargin is 0 under the
  // digital looks, which make every term here exactly zero.
  let outward = aLocal * 2.0 - 1.0;
  let position = aPosition + outward * (uMargin / max(uScale, vec2<f32>(1e-6)));

  let mvp = globalUniforms.uProjectionMatrix
    * globalUniforms.uWorldTransformMatrix
    * localUniforms.uTransformMatrix;
  let pos = mvp * vec3<f32>(position, 1.0);
  o.position = vec4<f32>(pos.xy, 0.0, 1.0);
  // vLocal stretched by the same margin; vSize stays the UNEXPANDED note size,
  // so the SDF box itself is untouched.
  o.vLocal = aLocal + outward * (uMargin / max(aSize * uScale, vec2<f32>(1e-6)));
  o.vSize = aSize;
  o.vColor = aColor;
  return o;
}

@fragment
fn fsMain(v: VsOut) -> @location(0) vec4<f32> {
  // Aliased so the body below reads token-for-token like its GLSL twin.
  let uScale = noteUniforms.uScale;
  let uDpr = noteUniforms.uDpr;
  let uSketch = noteUniforms.uSketch;
  let uPen = noteUniforms.uPen;
  let uPaper = noteUniforms.uPaper;
  let uShape = noteUniforms.uShape;

  let sizePx = v.vSize * uScale;
  // The look's inset per side, capped at a tenth of the note's width (never
  // below the 1px gap) — see the GLSL twin.
  let inset = min(uShape.x, max(0.5, 0.1 * sizePx.x));
  let halfPx = max(0.5 * sizePx - vec2<f32>(inset), vec2<f32>(0.5));
  // Rounded pill corners, at the look's radius.
  let radius = min(uShape.y, min(halfPx.x, halfPx.y));
  // In CSS px from the note's centre. Reaches past ±halfPx under the sketch
  // look, where the vertex stage grew the quad by uMargin.
  let p = (v.vLocal - vec2<f32>(0.5)) * sizePx;
  // SDF rounded box, in CSS px (negative inside).
  let q = abs(p) - (halfPx - vec2<f32>(radius));
  let d = length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0) - radius;
  // One physical pixel of AA: adjacent fragments differ by 1/uDpr CSS px.
  let aa = 0.6 / uDpr;

  if (uSketch < 0.5) {
    // Flat fill: solid Synthesia note color (the white-key / black-key shade is
    // baked into vColor upstream) — no gradient, bevel, or rim. Literally the
    // same three lines as before the sketch look existed, and reached before a
    // single instruction of it runs.
    let coverage = 1.0 - smoothstep(-aa, aa, d);
    let flatAlpha = v.vColor.a * coverage;
    return vec4<f32>(v.vColor.rgb * flatAlpha, flatAlpha);
  }

  // --- the pen ----------------------------------------------------------------
  // Everything below is a function of the note's OWN local coordinates and its
  // seed — never of screen position. That is what keeps the ink riding with each
  // note as the lane scrolls instead of crawling underneath it.
  //
  // Displace the SDF: the drawn edge is the straight one, wobbled.
  let np = p * uPen.y + vec2<f32>(v.vSeed * 37.0, v.vSeed * 91.0);
  let ds = d
    + (fbm(np) - 0.5) * 2.0 * uPen.x
    + (fbm(np * 2.9 + 5.0) - 0.5) * 2.0 * uPen.x * 0.35;

  // Pen pressure — the line thins and thickens as it travels.
  let pressure = 0.55 + 0.75 * fbm(p * 0.09 + v.vSeed * 13.0);
  let w = uPen.z * pressure * 0.5;

  // Every smoothstep here runs low→high. The prototype wrote several of them
  // reversed (edge0 > edge1) to flip the ramp; that is undefined in BOTH GLSL ES
  // and WGSL, so each one is expressed as 1 - smoothstep instead.
  let ink = 1.0 - smoothstep(w - aa, w + aa, abs(ds));
  let inside = 1.0 - smoothstep(-aa, aa, ds);
  // A lighter second pass just outside — the stroke of a hand that went round
  // twice. This is what needs the quad's margin; it lands outside the note box.
  let ghost =
    (1.0 - smoothstep(w * 1.1, w * 2.6 + aa, abs(ds + uPen.z * 0.8))) * 0.22;

  // The ink is the note's own colour driven toward pencil-black, so two tracks
  // stay as distinguishable as they are today; the body is a wash of the same
  // colour, kept well clear of the paper or the note stops reading as a note.
  let inkColor = mix(v.vColor.rgb * 0.42, vec3<f32>(0.10, 0.09, 0.08), 0.28);
  let fill = mix(uPaper.rgb, v.vColor.rgb, 0.35 + 0.65 * uPen.w);

  // A crayon leaves more pigment where the hand pressed: shade the body rather
  // than filling it flat. Hatching is parallel strokes at ~35°, broken up by the
  // same noise.
  let tone = 0.86 + 0.20 * fbm(p * 0.11 + v.vSeed * 5.0);
  let hv = sin((p.x * 0.7 + p.y) * 0.55 + fbm(p * 0.2) * 3.0);
  let hatch = smoothstep(0.25, 0.9, hv) * uPaper.w * inside;

  let bodyA = inside * (0.52 + 0.48 * uPen.w);
  let body = mix(fill * tone, inkColor, hatch * 0.65);

  let edge = clamp(max(ink, ghost * 1.4), 0.0, 1.0);
  // vColor.a is the note's velocity-driven alpha, exactly as in the flat path:
  // the pen changes how a note is drawn, never how loud it reads.
  let alpha = max(bodyA, max(ink, ghost)) * v.vColor.a;
  return vec4<f32>(mix(body, inkColor, edge) * alpha, alpha);
}
`;

export interface NoteMeshHandle {
  /** The single mesh holding every note; mount under the content-scaled layer. */
  mesh: Mesh<Geometry, Shader>;
  /** Rebuild ALL vertex/index buffers from the visuals (score change). */
  setNotes(
    visuals: readonly NoteVisual[],
    resolveColor: (expr: string) => number,
  ): void;
  /** Update the pixel-mapping uniforms (lane resize / DPR / spread change). The
   *  `pxPerSec` Y-scale is the effective `PX_PER_SECOND * spread`, so the SDF
   *  corner/inset math stays in real pixels at any zoom. O(1). */
  setUniforms(scaleX: number, dpr: number, pxPerSec: number): void;
  /**
   * New look: adopt its pen. A look change is a UNIFORM write, never a rebuild —
   * one shader pair carries both looks behind a branch flag, so toggling costs
   * no pipeline compile and the scene (whose layers the FX plugins hold direct
   * references to) is never rebuilt.
   *
   * `sketch` picks the branch; `marginPx` is how far outside its own box the pen
   * may write, which the VERTEX stage turns into a bigger quad. Under the digital looks
   * both are 0 and the rest of the pen is never read.
   */
  setLook(pen: SonataLookStyle["pen"], notes: SonataLookStyle["notes"]): void;
  /** Rewrite ONLY the color buffer (theme flip) — geometry untouched. */
  recolor(
    visuals: readonly NoteVisual[],
    resolveColor: (expr: string) => number,
  ): void;
  destroy(): void;
}

/** Pack one note's color bytes: the resolved fill color (`fillExpr` already
 *  carries the Synthesia white-key / black-key shade), alpha = velocity-driven
 *  visual alpha. Un-premultiplied in the buffer; the fragment shader
 *  premultiplies at output. */
function writeColor(
  out: Uint8Array,
  byteOffset: number,
  visual: NoteVisual,
  resolveColor: (expr: string) => number,
): void {
  const rgb = resolveColor(visual.fillExpr);
  const r = (rgb >> 16) & 0xff;
  const g = (rgb >> 8) & 0xff;
  const b = rgb & 0xff;
  const a = Math.round(Math.max(0, Math.min(1, visual.alpha)) * 255);
  for (let corner = 0; corner < 4; corner++) {
    const o = byteOffset + corner * 4;
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
    out[o + 3] = a;
  }
}

export function createNoteMesh(): NoteMeshHandle {
  // Separate buffer per attribute: `recolor` then touches exactly one upload,
  // and `setNotes` swaps `.data` wholesale (Pixi resizes the GPU buffer).
  const positionBuffer = new Buffer({
    data: new Float32Array(0),
    usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
  });
  const localBuffer = new Buffer({
    data: new Float32Array(0),
    usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
  });
  const sizeBuffer = new Buffer({
    data: new Float32Array(0),
    usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
  });
  const colorBuffer = new Buffer({
    data: new Uint8Array(0),
    usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
  });
  const indexBuffer = new Buffer({
    data: new Uint32Array(0),
    usage: BufferUsage.INDEX | BufferUsage.COPY_DST,
  });

  const geometry = new Geometry({
    attributes: {
      // Named `aPosition` (not `aPos`) so Pixi's geometry-bounds helper — which
      // looks this name up — keeps working for culling/bounds queries.
      aPosition: { buffer: positionBuffer, format: "float32x2" },
      aLocal: { buffer: localBuffer, format: "float32x2" },
      aSize: { buffer: sizeBuffer, format: "float32x2" },
      // unorm8x4 → arrives in the shader as a 0..1 vec4; 4 bytes/vertex.
      aColor: { buffer: colorBuffer, format: "unorm8x4" },
    },
    indexBuffer,
  });

  // FIELD ORDER IS LOAD-BEARING: Pixi derives the WebGPU UBO layout from this
  // declaration order, and the hand-authored WGSL `struct` must match it field
  // for field — a mismatch is silent and WebGPU-only. The GL path is unaffected
  // either way: it names uniforms individually and skips any the compiled
  // program does not declare, so order means nothing to it.
  //
  //   uScale (vec2) | uDpr (f32) | uSketch (f32) | uMargin (f32)
  //                 | uPen (vec4: wobble, grain, stroke, wash)
  //                 | uPaper (vec4: r, g, b, hatch)
  //                 | uShape (vec2: inset px, radius px)
  const noteUniforms = new UniformGroup({
    uScale: { value: new Float32Array([1, PX_PER_SECOND]), type: "vec2<f32>" },
    uDpr: { value: 1, type: "f32" },
    uSketch: { value: 0, type: "f32" },
    uMargin: { value: 0, type: "f32" },
    uPen: { value: new Float32Array([0, 0, 0, 0]), type: "vec4<f32>" },
    uPaper: { value: new Float32Array([0, 0, 0, 0]), type: "vec4<f32>" },
    uShape: { value: new Float32Array([0.5, 4]), type: "vec2<f32>" },
  });

  const shader = Shader.from({
    gl: {
      vertex: GLSL_VERTEX,
      fragment: GLSL_FRAGMENT,
      name: "piano-roll-notes",
    },
    gpu: {
      vertex: { source: WGSL_SOURCE, entryPoint: "vsMain" },
      fragment: { source: WGSL_SOURCE, entryPoint: "fsMain" },
      name: "piano-roll-notes",
    },
    resources: { noteUniforms },
  });

  const mesh = new Mesh<Geometry, Shader>({ geometry, shader });

  return {
    mesh,

    setNotes(visuals, resolveColor) {
      const n = visuals.length;
      // An empty draw is legal but pointless — and keeps zero-sized buffers out
      // of the backends entirely.
      mesh.visible = n > 0;

      const positions = new Float32Array(n * 8);
      const locals = new Float32Array(n * 8);
      const sizes = new Float32Array(n * 8);
      const colors = new Uint8Array(n * 16);
      const indices = new Uint32Array(n * 6);

      for (let i = 0; i < n; i++) {
        const v = visuals[i]!;
        const x0 = v.xFrac;
        const x1 = v.xFrac + v.wFrac;
        // Authored content space: y = -seconds. The note END (later) is the
        // TOP (more negative), the onset is the bottom — same as the DOM rects.
        const yTop = -v.y1Sec;
        const yBottom = -v.y0Sec;
        const hSec = v.y1Sec - v.y0Sec;

        const f = i * 8;
        // Corner order: TL, TR, BR, BL — aLocal is the matching corner UV.
        positions[f] = x0;
        positions[f + 1] = yTop;
        positions[f + 2] = x1;
        positions[f + 3] = yTop;
        positions[f + 4] = x1;
        positions[f + 5] = yBottom;
        positions[f + 6] = x0;
        positions[f + 7] = yBottom;
        locals[f] = 0;
        locals[f + 1] = 0;
        locals[f + 2] = 1;
        locals[f + 3] = 0;
        locals[f + 4] = 1;
        locals[f + 5] = 1;
        locals[f + 6] = 0;
        locals[f + 7] = 1;
        for (let corner = 0; corner < 4; corner++) {
          sizes[f + corner * 2] = v.wFrac;
          sizes[f + corner * 2 + 1] = hSec;
        }
        writeColor(colors, i * 16, v, resolveColor);

        const vi = i * 4;
        const ii = i * 6;
        indices[ii] = vi;
        indices[ii + 1] = vi + 1;
        indices[ii + 2] = vi + 2;
        indices[ii + 3] = vi;
        indices[ii + 4] = vi + 2;
        indices[ii + 5] = vi + 3;
      }

      positionBuffer.data = positions;
      localBuffer.data = locals;
      sizeBuffer.data = sizes;
      colorBuffer.data = colors;
      indexBuffer.data = indices;
    },

    setUniforms(scaleX, dpr, pxPerSec) {
      const uScale = noteUniforms.uniforms.uScale as Float32Array;
      uScale[0] = scaleX;
      uScale[1] = pxPerSec;
      noteUniforms.uniforms.uDpr = dpr;
      noteUniforms.update();
    },

    setLook(pen, notes) {
      const uShape = noteUniforms.uniforms.uShape as Float32Array;
      uShape[0] = notes.insetPx;
      uShape[1] = notes.radiusPx;
      noteUniforms.uniforms.uSketch = pen.sketch;
      noteUniforms.uniforms.uMargin = pen.marginPx;
      const uPen = noteUniforms.uniforms.uPen as Float32Array;
      uPen[0] = pen.wobble;
      uPen[1] = pen.grain;
      uPen[2] = pen.stroke;
      uPen[3] = pen.wash;
      const uPaper = noteUniforms.uniforms.uPaper as Float32Array;
      uPaper[0] = pen.paper[0];
      uPaper[1] = pen.paper[1];
      uPaper[2] = pen.paper[2];
      uPaper[3] = pen.hatch;
      noteUniforms.update();
    },

    recolor(visuals, resolveColor) {
      const n = visuals.length;
      const colors = new Uint8Array(n * 16);
      for (let i = 0; i < n; i++) {
        writeColor(colors, i * 16, visuals[i]!, resolveColor);
      }
      colorBuffer.data = colors;
    },

    destroy() {
      // Destroy geometry/shader explicitly (mesh.destroy keeps shared
      // resources alive by default; ours are exclusive).
      mesh.destroy();
      geometry.destroy(true);
      shader.destroy(true);
    },
  };
}
