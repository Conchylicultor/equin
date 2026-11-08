/* Casino footwork engine.
 *
 * World: metres, x = east, y = north. Heading h: degrees clockwise from north,
 * kept unwrapped (540 = one and a half turns) so turns interpolate the right way.
 *
 * Layers
 *   Step      — what one foot does on one count, in the dancer's OWN frame
 *   Hands     — who holds whose hand, at what height, over whose head
 *   Positions — named relations between the two dancers (open, closed, side)
 *   solve()   — integrates the 8 counts into poses and CHECKS the figure:
 *               weight must alternate, 4 and 8 are pauses, the figure must end
 *               where it says it ends, bodies must not overlap, arms must reach.
 */
(function (G) {
  const RAD = Math.PI / 180;
  const STANCE = 0.18;     // distance between the two feet when closed
  const SHOULDER = 0.2;    // half shoulder width
  const ARM = 0.62;        // shoulder → hand reach

  const fwdV = (h) => [Math.sin(h * RAD), Math.cos(h * RAD)];
  const rightV = (h) => [Math.cos(h * RAD), -Math.sin(h * RAD)];
  const add = (p, v, k = 1) => [p[0] + v[0] * k, p[1] + v[1] * k];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const lerp2 = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
  const sideOf = (f) => (f === "L" ? -1 : 1);
  const other = (f) => (f === "L" ? "R" : "L");
  const wrap = (h) => ((h % 360) + 360) % 360;
  const angDiff = (a, b) => { const d = wrap(a - b); return d > 180 ? 360 - d : d; };

  /* ---------------- Step vocabulary (dancer's own frame) ----------------
   * move steps are anchored on the body centre; `turn` is applied first, and
   * f (forward) / side (outward, away from the other foot) are measured in the
   * NEW facing. Think: "where do I face after this step, and which way did I go?" */
  const Step = {
    fwd: (foot, len = 0.14, o = {}) => ({ op: "move", foot, f: len, s: o.side || 0, turn: o.turn || 0 }),
    back: (foot, len = 0.14, o = {}) => ({ op: "move", foot, f: -len, s: o.side || 0, turn: o.turn || 0 }),
    side: (foot, len = 0.14, o = {}) => ({ op: "move", foot, f: o.f || 0, s: len, turn: o.turn || 0 }),
    close: (foot, o = {}) => ({ op: "close", foot, turn: o.turn || 0 }),       // beside the other foot
    replace: (foot, o = {}) => ({ op: "replace", foot, turn: o.turn || 0 }),   // weight back onto a foot that stays put
    pivot: (turn) => ({ op: "pivot", turn }),                                   // turn on the weighted foot
    pause: () => ({ op: "pause" }),
    tap: (foot) => ({ op: "tap", foot }),                                       // touch the free foot, no weight
    /** a traveling step: the body arrives at [x, y] in the FIGURE frame (you start at the origin facing north). */
    to: (foot, at, o = {}) => ({ op: "to", foot, at, turn: o.turn || 0 }),
  };
  const WEIGHT_OPS = new Set(["move", "close", "replace", "to"]);

  /* ---------------- Hands ----------------
   * A connection is the state of the hands AFTER a count lands. Geometry is
   * derived from the two bodies; nothing is placed by hand. */
  const HEIGHTS = ["low", "waist", "chest", "shoulder", "head", "overhead"];
  const Hands = {
    /** his `lead` hand holds her `follow` hand. over: "her" | "him" puts the joint above that head. */
    hold: (lead, follow, height = "waist", o = {}) => ({ kind: "hold", lead, follow, height, over: o.over || null, halo: !!o.halo, palm: !!o.palm }),
    /** closed position: his right hand on her left shoulder blade, her left hand on his right shoulder */
    back: () => ({ kind: "back" }),
  };
  const connKey = (c) => (c.kind === "back" ? "back" : `hold:${c.lead}${c.follow}`);

  /* ---------------- Positions (follower relative to leader's frame) ---------------- */
  const Positions = {
    open: { name: "Open position", rel: { x: 0, y: 0.85, h: 180 }, hands: [Hands.hold("L", "R", "waist")] },
    closed: { name: "Closed position", rel: { x: 0.1, y: 0.36, h: 180 }, hands: [Hands.hold("L", "R", "shoulder"), Hands.back()] },
    side: { name: "Side by side, right hip to right hip", rel: { x: 0.36, y: 0, h: 180 }, hands: [Hands.hold("L", "R", "waist")] },
  };
  const TOL = { dist: 0.14, ang: 20 };

  /* ---------------- Dancer state ---------------- */
  // The body centre sits between the feet, shifted halfway toward the weighted one.
  const LEAN = 0.5;
  function stand(center, h, weight) {
    const r = rightV(h), shift = weight === "B" ? 0 : -sideOf(weight) * LEAN * STANCE / 2;
    const m = add(center, r, shift);
    return {
      feet: { L: { p: add(m, r, -STANCE / 2), h }, R: { p: add(m, r, STANCE / 2), h } },
      w: weight, h,
    };
  }
  function centerOf(st) {
    if (st.c) return st.c;  // an interpolated pose carries its own centre
    const m = mid(st.feet.L.p, st.feet.R.p);
    return st.w === "B" ? m : lerp2(m, st.feet[st.w].p, LEAN);
  }
  const clone = (st) => ({ feet: { L: { ...st.feet.L }, R: { ...st.feet.R } }, w: st.w, h: st.h });

  function apply(st0, op, where, errors) {
    const st = clone(st0);
    const meta = { moved: null, tap: null };
    const need = (cond, msg) => { if (!cond) errors.push(`${where}: ${msg}`); };
    switch (op.op) {
      case "move": {
        need(st.w !== op.foot, `${op.foot} steps but the weight is already on it`);
        const h = st.h + op.turn, c = centerOf(st);
        const p = add(add(c, fwdV(h), op.f), rightV(h), sideOf(op.foot) * (STANCE / 2 + op.s));
        st.feet[op.foot] = { p, h }; st.w = op.foot; st.h = h; meta.moved = op.foot;
        break;
      }
      case "to": {
        need(st.w !== op.foot, `${op.foot} steps but the weight is already on it`);
        const h = st.h + op.turn, sup = st.feet[other(op.foot)].p;
        // place the foot so the resulting centre lands exactly on `at`
        const k = (1 + LEAN) / 2;
        const p = [(op.at[0] - (1 - k) * sup[0]) / k, (op.at[1] - (1 - k) * sup[1]) / k];
        st.feet[op.foot] = { p, h }; st.w = op.foot; st.h = h; meta.moved = op.foot;
        break;
      }
      case "close": {
        const sup = other(op.foot);
        need(st.w !== op.foot, `${op.foot} closes but the weight is already on it`);
        const h = st.h + op.turn;
        st.feet[op.foot] = { p: add(st.feet[sup].p, rightV(h), sideOf(op.foot) * STANCE), h };
        st.w = op.foot; st.h = h; meta.moved = op.foot;
        break;
      }
      case "replace": {
        need(st.w === other(op.foot), `weight goes back onto ${op.foot}, but it was not on ${other(op.foot)}`);
        st.h += op.turn; st.feet[op.foot].h += op.turn; st.w = op.foot; meta.moved = op.foot;
        break;
      }
      case "pivot": {
        need(st.w === "L" || st.w === "R", "a pivot needs the weight on one foot");
        const on = st.w === "B" ? "L" : st.w, free = other(on);
        const o = st.feet[on].p, v = sub(st.feet[free].p, o), a = op.turn * RAD;
        st.feet[free] = { p: [o[0] + v[0] * Math.cos(a) + v[1] * Math.sin(a), o[1] - v[0] * Math.sin(a) + v[1] * Math.cos(a)], h: st.feet[free].h + op.turn };
        st.feet[on].h += op.turn; st.h += op.turn;
        break;
      }
      case "tap":
        need(st.w !== op.foot, `taps ${op.foot} but the weight is on it`);
        meta.tap = op.foot;
        break;
      case "pause": break;
      default: throw new Error(`${where}: unknown step op ${op.op}`);
    }
    return { st, meta };
  }

  /* ---------------- Hand geometry ---------------- */
  const shoulder = (st, side) => add(centerOf(st), rightV(st.h), sideOf(side) * SHOULDER);
  function handGeo(L, F, conns, phase = 0) {
    const cl = centerOf(L), cf = centerOf(F);
    const free = (st, side) => ({ p: add(shoulder(st, side), fwdV(st.h), 0.16), height: "waist", joined: false, free: true });
    const out = { lead: { L: free(L, "L"), R: free(L, "R") }, follow: { L: free(F, "L"), R: free(F, "R") }, joints: [] };
    for (const c of conns) {
      if (c.kind === "back") {
        const p = add(add(cf, fwdV(F.h), -0.12), rightV(F.h), -0.1);
        out.lead.R = { p, height: "shoulder", joined: true, onBack: true };
        out.follow.L = { p: add(shoulder(L, "R"), fwdV(L.h), 0.03), height: "shoulder", joined: true, onShoulder: true };
      } else {
        let p = c.over === "her" ? cf : c.over === "him" ? cl : mid(shoulder(L, c.lead), shoulder(F, c.follow));
        if (c.halo) p = add(p, [Math.cos(phase), Math.sin(phase)], 0.07);
        const h = { p, height: c.height, joined: true, palm: c.palm, halo: c.halo };
        out.lead[c.lead] = h; out.follow[c.follow] = { ...h };
        out.joints.push({ p, height: c.height, palm: c.palm, halo: c.halo, over: c.over, center: c.over === "her" ? cf : c.over === "him" ? cl : null });
      }
    }
    return out;
  }

  /* ---------------- Solve + check ---------------- */
  const PAUSES = new Set([4, 8]);
  function solve(fig) {
    if (fig.counts.length !== 8) throw new Error(`${fig.name}: a figure is 8 counts, got ${fig.counts.length}`);
    const errors = [], warnings = [];
    const L0 = stand([0, 0], 0, "R");      // figure frame: you start at the origin facing north, left foot free
    const r = fig.start.rel;
    const fc = add(add(centerOf(L0), rightV(0), r.x), fwdV(0), r.y);
    const F0 = stand(fc, r.h, "L");         // follower starts with the right foot free
    const frames = [{ count: 0, L: L0, F: F0, hands: fig.start.hands, lm: {}, fm: {} }];
    let L = L0, F = F0, hands = fig.start.hands;
    fig.counts.forEach((c, i) => {
      const n = i + 1;
      for (const [who, s] of [["lead", c.lead.step], ["follow", c.follow.step]]) {
        if (PAUSES.has(n) && WEIGHT_OPS.has(s.op)) errors.push(`count ${n} (${who}): ${n} is a pause in Cuban timing, but a weight step is written`);
        if (!PAUSES.has(n) && !WEIGHT_OPS.has(s.op)) errors.push(`count ${n} (${who}): steps land on ${n}, but no weight change is written`);
      }
      const a = apply(L, c.lead.step, `count ${n} (you)`, errors);
      const b = apply(F, c.follow.step, `count ${n} (her)`, errors);
      L = a.st; F = b.st; if (c.hands) hands = c.hands;
      const gap = dist(centerOf(L), centerOf(F));
      if (gap < 0.24) warnings.push(`count ${n}: bodies overlap (${Math.round(gap * 100)} cm apart)`);
      const g = handGeo(L, F, hands);
      for (const [who, st] of [["lead", L], ["follow", F]]) for (const side of ["L", "R"]) {
        const hd = g[who][side]; if (!hd.joined || hd.onBack || hd.onShoulder || hd.height === "overhead") continue;
        const reach = dist(shoulder(st, side), hd.p);
        if (reach > ARM + 0.08) warnings.push(`count ${n}: ${who === "lead" ? "your" : "her"} ${side === "L" ? "left" : "right"} arm is stretched (${Math.round(reach * 100)} cm)`);
      }
      frames.push({ count: n, L, F, hands, lm: a.meta, fm: b.meta });
    });
    // Does it end where it says?
    const cl = centerOf(L), d = sub(centerOf(F), cl);
    const rel = { x: dot(d, rightV(L.h)), y: dot(d, fwdV(L.h)), h: wrap(F.h - L.h) };
    const want = fig.end.rel;
    const off = Math.hypot(rel.x - want.x, rel.y - want.y), offH = angDiff(rel.h, want.h);
    const endOk = off <= TOL.dist && offH <= TOL.ang;
    const endHandsOk = [...new Set(hands.map(connKey))].sort().join() === [...new Set(fig.end.hands.map(connKey))].sort().join();
    const weightOk = L.w === "R" && F.w === "L";
    if (!weightOk) errors.push(`ends with the weight on ${L.w} (you) / ${F.w} (her): the next 1 would start on the wrong foot`);
    const back = { off: dist(cl, centerOf(L0)), offH: angDiff(L.h, 0) };
    const closes = back.off < 0.05 && back.offH < 5 && dist(centerOf(F), centerOf(F0)) < 0.05;
    return { frames, errors, warnings, end: { rel, off, offH, ok: endOk, handsOk: endHandsOk }, closes };
  }

  G.Engine = { Step, Hands, Positions, HEIGHTS, solve, handGeo, centerOf, shoulder, fwdV, rightV, add, lerp2, dist, STANCE };
})(typeof window !== "undefined" ? window : globalThis);
