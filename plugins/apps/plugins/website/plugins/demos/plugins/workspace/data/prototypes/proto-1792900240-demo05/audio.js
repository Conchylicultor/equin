/* Transport: ONE musical clock for picture and sound.
 *
 * Position u is in beats, 0 ≤ u < 8: count n lands at u = n - 1.
 * While playing, u is read from the audio clock, and every sound is scheduled
 * on that same clock, so the dancers cannot drift from the beat. */
(function (G) {
  // Where each instrument plays inside one 8-count bar (u positions; .5 = the "and").
  const PATTERNS = {
    campana: [0, 1, 2, 3, 4, 5, 6, 7],             // bell on every count, accent on 1 and 5
    clave: [1, 2, 4, 5.5, 7],                      // son clave 2-3: 2, 3 | 5, 6&, 8
    conga: [1, 3, 3.5, 5, 7, 7.5],                 // tumbao: slap on 2 and 6, open tones on 4, 4&, 8, 8&
  };
  const ACCENT = new Set([0, 4]);
  const SLAP = new Set([1, 5]);

  let ctx = null, out = null;
  const on = { campana: true, clave: true, conga: true };
  const state = { playing: false, loop: true, bpm: 90, anchorT: 0, anchorU: 0, scheduledTo: 0, timer: 0, onEnd: null };

  const now = () => (ctx ? ctx.currentTime : performance.now() / 1000);
  function ensureCtx() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      out = ctx.createGain(); out.gain.value = 0.55; out.connect(ctx.destination);
    }
    if (ctx.state === "suspended") ctx.resume();
  }

  /* ---- instruments ---- */
  function env(t, peak, decay) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    g.connect(out);
    return g;
  }
  function osc(type, f, t, dur, dest, fEnd) {
    const o = ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f, t);
    if (fEnd) o.frequency.exponentialRampToValueAtTime(fEnd, t + dur * 0.6);
    o.connect(dest); o.start(t); o.stop(t + dur + 0.02);
  }
  const SOUNDS = {
    campana(t, p) {
      const g = env(t, ACCENT.has(p) ? 0.34 : 0.14, 0.16);
      const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 900; bp.Q.value = 2.5; bp.connect(g);
      osc("square", 560, t, 0.16, bp); osc("square", 845, t, 0.16, bp);
    },
    clave(t) {
      const g = env(t, 0.42, 0.07);
      osc("sine", 2500, t, 0.07, g); osc("triangle", 1250, t, 0.05, g);
    },
    conga(t, p) {
      if (SLAP.has(p)) { const g = env(t, 0.22, 0.06); osc("triangle", 420, t, 0.06, g, 300); }
      else { const g = env(t, 0.4, 0.28); osc("sine", 230, t, 0.28, g, 190); }
    },
  };

  /* ---- clock ---- */
  const beatsPerSec = () => state.bpm / 60;
  function rawU(t = now()) { return state.anchorU + (t - state.anchorT) * beatsPerSec(); }
  function position() {
    if (!state.playing) return state.anchorU;
    const u = rawU();
    if (state.loop) return ((u % 8) + 8) % 8;
    return Math.min(u, 8 - 1e-6);
  }

  // Lookahead scheduler: the only timer here, and it only queues sounds ahead of the audio clock.
  function schedule() {
    if (!state.playing || !ctx) return;
    const horizon = rawU(now() + 0.12);
    let s = Math.ceil(state.scheduledTo * 2 - 1e-9) / 2;
    for (; s < horizon; s += 0.5) {
      if (!state.loop && s >= 8) break;
      const p = ((s % 8) + 8) % 8;
      const t = state.anchorT + (s - state.anchorU) / beatsPerSec();
      for (const k of Object.keys(PATTERNS)) if (on[k] && PATTERNS[k].includes(p)) SOUNDS[k](Math.max(t, now()), p);
    }
    state.scheduledTo = s;
    if (!state.loop && rawU() >= 8) { pause(8 - 1e-6); state.onEnd && state.onEnd(); }
  }

  function play() {
    ensureCtx();
    let u = state.anchorU;
    if (!state.loop && u >= 7.99) u = 0;
    state.anchorU = u; state.anchorT = now(); state.scheduledTo = u; state.playing = true;
    clearInterval(state.timer); state.timer = setInterval(schedule, 25); schedule();
  }
  function pause(at) {
    const u = at ?? position();
    state.playing = false; clearInterval(state.timer); state.anchorU = u;
  }
  function seek(u) { const was = state.playing; pause(u); if (was) play(); }
  function setBpm(b) { const u = position(); state.bpm = b; if (state.playing) { state.anchorU = u; state.anchorT = now(); state.scheduledTo = u; } }

  G.Transport = {
    PATTERNS, on, state, position, play, pause, seek, setBpm,
    setLoop(v) { const u = position(); state.loop = v; if (state.playing) { state.anchorU = u; state.anchorT = now(); state.scheduledTo = u; } },
  };
})(window);
