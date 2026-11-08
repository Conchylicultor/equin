/* View: draws a solved figure at musical position u, and the text for the count. */
(function () {
  const E = Engine, T = Transport;
  const FIGS = FIGURES.map((f) => ({ ...f, sol: E.solve(f) }));
  const $ = (id) => document.getElementById(id);
  const NS = "http://www.w3.org/2000/svg";
  const lerp = (a, b, k) => a + (b - a) * k;
  const ease = (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
  const SIDE = { L: "left", R: "right" };
  const SHOE = "M0,-.1 C.05,-.1 .052,-.02 .045,.03 C.04,.08 .03,.1 0,.1 C-.03,.1 -.04,.08 -.045,.03 C-.052,-.02 -.05,-.1 0,-.1Z";

  const svg = $("stage");
  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    (parent || svg).appendChild(e);
    return e;
  }
  const gGrid = el("g", {}), gPrints = el("g", {}), gScene = el("g", {});

  /* ---------------- timeline: which two poses, and how far between ---------------- */
  // Count n lands at u = n-1; the foot travels during the "and" before it (the last half beat).
  function timeline(sol, u, loop) {
    const P = sol.frames, count = Math.min(8, Math.floor(u) + 1);
    const at = (A, B, a, alpha = 1, wrap = false) => ({ A, B, a: ease(Math.max(0, Math.min(1, a))), alpha, wrap, count, frac: u - (count - 1) });
    if (u >= 7) {
      if (!loop) return at(P[8], P[8], 0);
      if (u < 7.5) {
        if (sol.closes) return at(P[8], P[8], 0);
        // the figure does not end where it started: fade back to the start during the pause on 8
        return u < 7.25 ? at(P[8], P[8], 0, 1 - (u - 7) / 0.25) : at(P[0], P[0], 0, (u - 7.25) / 0.25, true);
      }
      return at(P[0], P[1], (u - 7.5) / 0.5, 1, true); // the "and" of 8: next count 1 on its way
    }
    const fr = u - (count - 1);
    return fr < 0.5 ? at(P[count], P[count], 0) : at(P[count], P[count + 1], (fr - 0.5) / 0.5);
  }
  function mix(A, B, a) {
    const f = (x, y) => ({ p: E.lerp2(x.p, y.p, a), h: lerp(x.h, y.h, a) });
    return { feet: { L: f(A.feet.L, B.feet.L), R: f(A.feet.R, B.feet.R) }, h: lerp(A.h, B.h, a), w: a < 0.5 ? A.w : B.w, c: E.lerp2(E.centerOf(A), E.centerOf(B), a) };
  }

  /* ---------------- drawing ---------------- */
  const Y = (p) => [p[0], -p[1]];
  function drawFoot(g, foot, weighted, lift, color, label) {
    const [x, y] = Y(foot.p), s = 1 + 0.28 * lift;
    const f = el("g", { transform: `translate(${x},${y}) rotate(${foot.h}) scale(${s})` }, g);
    el("path", { d: SHOE, fill: weighted ? color : "var(--floor)", stroke: color, "stroke-width": 0.013 }, f);
    const t = el("text", { x, y, "text-anchor": "middle", "dominant-baseline": "central", "font-size": 0.058, "font-weight": 700, fill: weighted ? "var(--surface)" : color }, g);
    t.textContent = label;
  }
  // Shoulders are a see-through ring so the feet under them stay readable; head and nose on top.
  function drawDancer(g, st, lift, tap, color, soft, name) {
    const [x, y] = Y(E.centerOf(st));
    const b = el("g", { transform: `translate(${x},${y}) rotate(${st.h})` }, g);
    el("ellipse", { cx: 0, cy: 0, rx: 0.2, ry: 0.085, fill: soft, stroke: color, "stroke-width": 0.012, "fill-opacity": 0.35 }, b);
    for (const s of ["L", "R"]) drawFoot(g, st.feet[s], st.w === s || st.w === "B", lift[s] || (tap === s ? 1 : 0), color, s);
    const hd = el("g", { transform: `translate(${x},${y}) rotate(${st.h})` }, g);
    el("path", { d: "M-.04,-.085 L0,-.17 L.04,-.085Z", fill: color }, hd);
    el("circle", { cx: 0, cy: 0, r: 0.05, fill: color, stroke: "var(--floor)", "stroke-width": 0.01 }, hd);
    const tp = Y(E.add(E.centerOf(st), E.fwdV(st.h), -0.2));
    const t = el("text", { x: tp[0], y: tp[1] + 0.025, "text-anchor": "middle", "font-size": 0.07, "font-weight": 700, fill: color, "letter-spacing": ".01em" }, g);
    t.textContent = name;
  }
  const HR = (height) => 0.02 + E.HEIGHTS.indexOf(height) * 0.006;
  function drawArm(g, st, side, hand, color) {
    const s = Y(E.shoulder(st, side)), h = Y(hand.p);
    el("line", { x1: s[0], y1: s[1], x2: h[0], y2: h[1], stroke: color, "stroke-width": hand.free ? 0.014 : 0.022, "stroke-linecap": "round", opacity: hand.free ? 0.45 : 0.9 }, g);
    el("circle", { cx: h[0], cy: h[1], r: HR(hand.height), fill: color, opacity: hand.free ? 0.5 : 1 }, g);
  }
  function drawJoint(g, j) {
    const [x, y] = Y(j.p);
    if (j.center) { const [cx, cy] = Y(j.center); el("circle", { cx, cy, r: 0.11, fill: "none", stroke: "var(--beat)", "stroke-width": 0.01, "stroke-dasharray": ".025 .018" }, g); }
    el("circle", { cx: x, cy: y, r: HR(j.height) + 0.018, fill: "none", stroke: "var(--ink)", "stroke-width": 0.012, "stroke-dasharray": j.palm ? ".018 .012" : "none" }, g);
    if (j.height === "overhead") {
      const t = el("text", { x, y: y - HR(j.height) - 0.035, "text-anchor": "middle", "font-size": 0.06, "font-weight": 700, fill: "var(--beat)" }, g);
      t.textContent = "↑";
    }
  }
  function mixHands(ga, gb, a) {
    const pick = a < 0.5 ? ga : gb, out = { lead: {}, follow: {} };
    for (const who of ["lead", "follow"]) for (const s of ["L", "R"]) {
      const x = ga[who][s], y = gb[who][s];
      const hi = Math.round(lerp(E.HEIGHTS.indexOf(x.height), E.HEIGHTS.indexOf(y.height), a));
      out[who][s] = { ...pick[who][s], p: E.lerp2(x.p, y.p, a), height: E.HEIGHTS[hi] };
    }
    out.joints = pick.joints.map((j) => ({ ...j }));
    // a joint sits where the hands are now
    const conns = a < 0.5 ? ga.conns : gb.conns;
    conns.filter((c) => c.kind === "hold").forEach((c, i) => { out.joints[i].p = out.lead[c.lead].p; out.joints[i].height = out.lead[c.lead].height; });
    return out;
  }

  /* ---------------- world frame / grid ---------------- */
  function fit(sol) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const fr of sol.frames) for (const st of [fr.L, fr.F]) for (const p of [st.feet.L.p, st.feet.R.p, E.centerOf(st)]) {
      x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
    }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, size = Math.max(2.1, x1 - x0 + 0.8, y1 - y0 + 0.8);
    return { x: cx - size / 2, y: -cy - size / 2, size };
  }
  function drawGrid(v) {
    gGrid.textContent = "";
    el("rect", { x: v.x, y: v.y, width: v.size, height: v.size, fill: "var(--floor)" }, gGrid);
    const s0 = Math.floor(v.x * 2) / 2, s1 = v.x + v.size, t0 = Math.floor(v.y * 2) / 2, t1 = v.y + v.size;
    for (let a = s0; a <= s1; a += 0.5) el("line", { x1: a, y1: v.y, x2: a, y2: t1, stroke: "var(--grid)", "stroke-width": 0.006 }, gGrid);
    for (let b = t0; b <= t1; b += 0.5) el("line", { x1: v.x, y1: b, x2: s1, y2: b, stroke: "var(--grid)", "stroke-width": 0.006 }, gGrid);
    const sx = v.x + 0.12, sy = v.y + v.size - 0.1;
    el("line", { x1: sx, y1: sy, x2: sx + 0.5, y2: sy, stroke: "var(--muted)", "stroke-width": 0.012 }, gGrid);
    const t = el("text", { x: sx + 0.25, y: sy - 0.04, "text-anchor": "middle", "font-size": 0.065, fill: "var(--muted)" }, gGrid);
    t.textContent = "50 cm";
    const n = el("text", { x: v.x + v.size - 0.1, y: v.y + 0.14, "text-anchor": "end", "font-size": 0.065, fill: "var(--muted)" }, gGrid);
    n.textContent = "↑ you start facing this way";
  }

  /* ---------------- words ---------------- */
  function handsWords(conns) {
    if (!conns.length) return "Hands free.";
    return conns.map((c) => {
      if (c.kind === "back") return "Your right hand on her left shoulder blade, her left hand on your right shoulder.";
      const where = c.over ? `above ${c.over === "her" ? "her" : "your"} head` : `${c.height} height`;
      return `Your ${SIDE[c.lead]} holds her ${SIDE[c.follow]}${c.palm ? ", palm to palm" : ""}, ${where}${c.halo ? ", circling" : ""}.`;
    }).join(" ");
  }

  /* ---------------- UI ---------------- */
  let fig = FIGS[0], view = null, lastCount = -1;
  const PAUSE = new Set([4, 8]);

  $("tabs").innerHTML = FIGS.map((f) => `<button class="tab" role="tab" id="tab-${f.id}">${f.name}<small>${f.en}</small>${f.sol.errors.length || !f.sol.end.ok ? '<i class="bad" title="Checks fail">!</i>' : ""}</button>`).join("");
  FIGS.forEach((f) => ($("tab-" + f.id).onclick = () => select(f)));

  const clave = T.PATTERNS.clave;
  $("counts").innerHTML = Array.from({ length: 8 }, (_, i) => {
    const n = i + 1, dots = [i, i + 0.5].map((p) => `<i class="${clave.includes(p) ? "hit" : ""}"></i>`).join("");
    return `<button class="cnt ${PAUSE.has(n) ? "pause" : ""}" data-c="${n}"><span class="num">${n}</span><small>${PAUSE.has(n) ? "pause" : "step"}</small><span class="clave" aria-hidden="true">${dots}</span><span class="bar"></span></button>`;
  }).join("");
  document.querySelectorAll(".cnt").forEach((b) => (b.onclick = () => goCount(+b.dataset.c)));

  function goCount(n) { T.pause(n - 1); setPlayLabel(); render(); }
  function select(f) {
    fig = f; view = fit(f.sol); lastCount = -1;
    svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.size} ${view.size}`);
    drawGrid(view);
    FIGS.forEach((g) => $("tab-" + g.id).setAttribute("aria-selected", g === f));
    $("fname").textContent = f.name;
    $("fsub").textContent = `${f.en}. ${f.sub}`;
    $("fstart").textContent = f.start.name;
    $("fend").textContent = f.end.name;
    $("fprep").textContent = f.prep;
    const s = f.sol, ok = s.end.ok && s.end.handsOk && !s.errors.length;
    $("checks").className = "checks " + (ok ? "ok" : "fail");
    $("checks").innerHTML = (ok
      ? `<b>✓ Checks pass</b> Weight alternates, 4 and 8 are pauses, ends in ${f.end.name.toLowerCase()} (${Math.round(s.end.off * 100)} cm, ${Math.round(s.end.offH)}° off).`
      : `<b>✗ Checks fail</b> ${[...s.errors, !s.end.ok ? `Ends ${Math.round(s.end.off * 100)} cm / ${Math.round(s.end.offH)}° away from ${f.end.name.toLowerCase()}.` : "", !s.end.handsOk ? "Hands do not end as that position needs." : ""].filter(Boolean).join(" ")}`)
      + (s.warnings.length ? `<div class="warn">${s.warnings.join(" · ")}</div>` : "");
    $("rows").innerHTML = f.counts.map((c, i) => {
      const hands = s.frames[i + 1].hands, prev = s.frames[i].hands;
      return `<tr data-c="${i + 1}" class="${PAUSE.has(i + 1) ? "pause" : ""}"><td class="c">${i + 1}</td><td>${c.lead.say}</td><td class="her">${c.follow.say}</td><td class="hands">${hands !== prev || i === 0 ? handsWords(hands) : '<span class="same">same</span>'}</td></tr>`;
    }).join("");
    $("rows").querySelectorAll("tr").forEach((r) => (r.onclick = () => goCount(+r.dataset.c)));
    $("focus").innerHTML = f.focus.map((x) => `<li>${x}</li>`).join("");
    try { localStorage.setItem("casino-fig", f.id); } catch (e) { /* storage unavailable: nothing remembered */ }
    if (!T.state.playing) T.pause(0);
    render();
  }

  function render() {
    const u = T.position(), s = fig.sol, tl = timeline(s, u, T.state.loop);
    const L = mix(tl.A.L, tl.B.L, tl.a), F = mix(tl.A.F, tl.B.F, tl.a);
    const moving = tl.A !== tl.B, liftK = moving ? Math.sin(Math.PI * tl.a) : 0;
    const liftL = moving && tl.B.lm.moved ? { [tl.B.lm.moved]: liftK } : {};
    const liftF = moving && tl.B.fm.moved ? { [tl.B.fm.moved]: liftK } : {};
    const tapping = !moving && tl.frac > 0.2 && tl.frac < 0.55;
    const phase = u * Math.PI * 2;
    const ga = E.handGeo(tl.A.L, tl.A.F, tl.A.hands, phase); ga.conns = tl.A.hands;
    const gb = E.handGeo(tl.B.L, tl.B.F, tl.B.hands, phase); gb.conns = tl.B.hands;
    const hands = mixHands(ga, gb, tl.a);

    gScene.textContent = "";
    gScene.setAttribute("opacity", tl.alpha.toFixed(3));
    const gF = el("g", {}, gScene), gL = el("g", {}, gScene), gH = el("g", {}, gScene);
    drawDancer(gF, F, liftF, tapping ? tl.B.fm.tap : null, "var(--follow)", "var(--follow-soft)", "HER");
    drawDancer(gL, L, liftL, tapping ? tl.B.lm.tap : null, "var(--lead)", "var(--lead-soft)", "YOU");
    for (const side of ["L", "R"]) { drawArm(gH, F, side, hands.follow[side], "var(--follow)"); drawArm(gH, L, side, hands.lead[side], "var(--lead)"); }
    hands.joints.forEach((j) => drawJoint(gH, j));

    // numbered footprints for every count already danced in this bar
    gPrints.textContent = "";
    if ($("prints").checked && !tl.wrap && tl.alpha === 1) {
      for (let k = 1; k <= tl.count; k++) for (const [who, color] of [["F", "var(--follow)"], ["L", "var(--lead)"]]) {
        const fr = s.frames[k], m = who === "L" ? fr.lm.moved : fr.fm.moved;
        if (!m) continue;
        const foot = fr[who].feet[m], [x, y] = Y(foot.p);
        const g = el("g", { transform: `translate(${x},${y}) rotate(${foot.h})`, opacity: 0.55 }, gPrints);
        el("path", { d: SHOE, fill: "none", stroke: color, "stroke-width": 0.01, "stroke-dasharray": ".02 .012" }, g);
        const n = el("text", { x, y: y - 0.13, "text-anchor": "middle", "font-size": 0.068, "font-weight": 700, fill: color, "font-family": "var(--mono)" }, gPrints);
        n.textContent = k;
      }
    }

    // count strip + text follow the SAME count as the picture
    document.querySelectorAll(".cnt").forEach((b) => {
      const n = +b.dataset.c;
      b.classList.toggle("on", n === tl.count);
      b.style.setProperty("--p", n === tl.count ? Math.min(1, tl.frac).toFixed(3) : 0);
    });
    if (tl.count !== lastCount) {
      lastCount = tl.count;
      const c = fig.counts[tl.count - 1];
      $("rows").querySelectorAll("tr").forEach((r) => r.classList.toggle("on", +r.dataset.c === tl.count));
      $("nowc").textContent = `Count ${tl.count}${PAUSE.has(tl.count) ? " · pause" : ""}`;
      $("nowyou").textContent = c.lead.say;
      $("nowher").textContent = "She: " + c.follow.say;
      $("nowhands").textContent = "Hands: " + handsWords(s.frames[tl.count].hands);
    }
    $("wrapnote").hidden = !(tl.wrap || tl.alpha < 1);
  }

  /* ---------------- transport ---------------- */
  function setPlayLabel() { $("play").textContent = T.state.playing ? "Pause" : "Play"; }
  function frame() { if (T.state.playing) { render(); requestAnimationFrame(frame); } else { setPlayLabel(); render(); } }
  T.state.onEnd = () => setPlayLabel();
  $("play").onclick = () => { if (T.state.playing) T.pause(); else { T.play(); requestAnimationFrame(frame); } setPlayLabel(); render(); };
  const step = (d) => goCount(Math.max(1, Math.min(8, Math.floor(T.position()) + 1 + d)));
  $("prev").onclick = () => step(-1);
  $("next").onclick = () => step(1);
  $("bpm").oninput = (e) => { T.setBpm(+e.target.value); $("bpmv").textContent = e.target.value + " bpm"; };
  $("loop").onchange = (e) => T.setLoop(e.target.checked);
  $("prints").onchange = () => render();
  document.querySelectorAll("[data-inst]").forEach((b) => {
    b.onclick = () => { const k = b.dataset.inst; T.on[k] = !T.on[k]; b.setAttribute("aria-pressed", T.on[k]); };
    b.setAttribute("aria-pressed", T.on[b.dataset.inst]);
  });
  document.addEventListener("keydown", (e) => {
    if (e.target.closest("input")) return;
    if (e.code === "Space") { e.preventDefault(); $("play").click(); }
    else if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "ArrowRight") step(1);
  });
  T.setBpm(+$("bpm").value);

  // Deep link: #<figure>/<count>, e.g. #enchufla/3. Otherwise the last figure viewed.
  let startId = "guapea";
  try { startId = localStorage.getItem("casino-fig") || "guapea"; } catch (e) { /* storage unavailable: start on guapea */ }
  const [hashFig, hashCount] = location.hash.slice(1).split("/");
  select(FIGS.find((f) => f.id === (hashFig || startId)) || FIGS[0]);
  if (+hashCount >= 1 && +hashCount <= 8) goCount(+hashCount);
  setPlayLabel();
})();
