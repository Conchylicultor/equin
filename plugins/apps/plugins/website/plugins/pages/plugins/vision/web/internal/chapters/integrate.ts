import { n1, type Pt, type Rect } from "../kit/math";
import { circ } from "../kit/svg";
import { CURSOR, disc, expandIcon, type OsKind } from "../kit/night";
import { AC, C } from "../kit/palette";
import { Timeline, type PaneState } from "../kit/timeline";
import type { Frame } from "./frame";
import { CA } from "./geometry";
import {
  agentList,
  chatHead,
  CH,
  CONV,
  convAsk,
  convBody,
  convReply,
  CW,
  explorerBody,
  linkChip,
  linkLine,
  mapBody,
  PAGE,
  pageBelow,
  pageMain,
  pageSide,
  pageTop,
  protoBody,
  PUSH,
  SL,
  sonataBody,
  tileAt,
  TILES,
  videoBody,
  type Tile,
} from "./integrate-apps";

/**
 * Chapter 2 — all apps integrate with each other: one cycle inside the one
 * window. Only one app fills the window at a time (what it covers is gone); a
 * guest opens INSIDE its host, in the host's side column, growing out of what
 * opened it; expanding a guest grows that same surface into its full app.
 */

/** Chapter 2's apps, bottom to top, and the kind of OS window each becomes in chapter 3. */
export const INTEGRATE_APPS: readonly { part: string; kind: OsKind }[] = [
  { part: "page", kind: "doc" },
  { part: "conv", kind: "chat" },
  { part: "expl", kind: "grid" },
  { part: "proto", kind: "list" },
  { part: "video", kind: "chart" },
  { part: "son", kind: "keys" },
  { part: "page2", kind: "doc" },
];

/** The class of the typed line: drawn as a line of text, not as a link. */
export const TYPED_CLASS = "zb-typed";

export function integrateFrame(prefix: string): Frame {
  const sc = new Timeline(`${prefix}z2`, 22.4);
  const X = CA.x;
  const Y = CA.y;
  const M = PAGE.map;
  const H = CA.h;
  const full: Rect = { x: X, y: Y, w: CA.w, h: H };
  const slot: Rect = { x: X + SL.x, y: Y + SL.y, w: SL.w, h: H - 2 * SL.y };
  const chatR: Rect = {
    x: n1(X + CA.w - 14 - CW),
    y: n1(Y + 14),
    w: CW,
    h: CH,
  };
  const dot = (pt: Pt): Rect => ({
    x: pt[0] - 10,
    y: pt[1] - 10,
    w: 20,
    h: 20,
  });
  const mid = (r: Rect): Pt => [n1(r.x + r.w / 2), n1(r.y + r.h / 2)];
  const withO = (r: Rect, o: number): PaneState => ({ ...r, o });
  const tile = (k: Tile): Pt => {
    const p = tileAt(TILES.indexOf(k));
    return [X + p[0] + 30, Y + p[1] + 36];
  };
  const P_CHAT: Pt = [X + PAGE.chat[0], Y + PAGE.chat[1] + PUSH];
  const P_EXP: Pt = [chatR.x + CW - 18, chatR.y + 16];
  const P_PROTO: Pt = [
    X + CONV.agent[0] + CONV.proto[0],
    Y + CONV.agent[1] + CONV.proto[1],
  ];
  const P_FOLD: Pt = [slot.x + SL.w - 20, slot.y + 18];
  const P_PEXP: Pt = [slot.x + SL.w - 20, slot.y + 18];
  const LAYER = (o: number, x = 0, y = 0) => ({ x, y, s: 1, o });
  const SIDE_OFF = -126; // a page previewed in a side column shows its text, not its own sidebar

  // the page, and what lives in it, in the page's own units
  let b = sc.pane(
    "page",
    AC.page,
    pageTop() +
      sc.link("type", linkLine(), C.dim, { p: 0, o: 0.8 }, TYPED_CLASS) +
      sc.item("pchip", linkChip(), LAYER(0)) +
      sc.item("below", pageBelow(), LAYER(1)) +
      sc.pane(
        "map",
        AC.map,
        mapBody(M.w, M.h),
        { x: M.x, y: M.y, w: M.w, h: 0, o: 0 },
        true,
      ),
    withO(full, 1),
    true,
  );
  // the helper conversation, which is also the agent manager (the same surface, grown)
  b += sc.pane(
    "conv",
    AC.chat,
    sc.item("chead", chatHead(), LAYER(1)) +
      sc.item("alist", agentList(H), LAYER(0)) +
      sc.item(
        "talk",
        convBody(sc.fade("ask", convAsk()), sc.fade("reply", convReply())),
        LAYER(1, CONV.chat[0], CONV.chat[1]),
      ),
    withO({ x: chatR.x + 40, y: chatR.y, w: CW, h: CH }, 0),
    true,
  );
  // the explorer: it takes the conversation's place, around the prototype (drawn beneath the side column)
  b += sc.pane("expl", AC.file, explorerBody(H), withO(dot(P_FOLD), 0), true);
  b += sc.pane("proto", AC.proto, protoBody(), withO(dot(P_PROTO), 0), true);
  b += sc.pane(
    "video",
    AC.video,
    videoBody(),
    withO(dot(tile("video")), 0),
    true,
  );
  b += sc.pane(
    "son",
    AC.sonata,
    sonataBody(`${prefix}zsonclip2`),
    withO(dot(tile("note")), 0),
    true,
  );
  // the page previewed from the explorer, which expands into the very page the cycle starts on
  b += sc.pane(
    "page2",
    AC.page,
    sc.item("pside", pageSide(), LAYER(0)) +
      sc.item("pmain", pageMain() + pageBelow(), LAYER(1, SIDE_OFF, 18)) +
      sc.item("pexp", expandIcon(SL.w - 20, 18, AC.page), LAYER(1)),
    withO(dot(tile("page")), 0),
    true,
  );
  b += sc.item("ripple", circ(0, 0, 12, "zb-ripple"), {
    x: 0,
    y: 0,
    s: 0.5,
    o: 0,
  });
  b += sc.item("cursor", CURSOR, { x: X + 300, y: Y + H + 20, s: 1, o: 0 });

  // The verbs. click: the cursor travels to pt and clicks at t (returns when what it opens starts).
  // open: a guest grows out of where it was opened from into its place. close: back where it came
  // from. swap: the side column's guest gives way to another. cover: an app now fills the window,
  // so the ones beneath it are gone.
  let cursorAt: Pt | null = null;
  const click = (t: number, pt: Pt) => {
    if (!cursorAt) sc.at(t - 1.0, "cursor", { o: 1 }, 0.3);
    sc.at(t - 0.9, "cursor", { x: pt[0] + 6, y: pt[1] + 3 }, 0.8);
    sc.at(t, "ripple", { x: pt[0], y: pt[1], s: 0.5, o: 0.9 }, 0).at(
      t,
      "ripple",
      { s: 2.6, o: 0 },
      0.8,
      "out",
    );
    cursorAt = pt;
    return t + 0.1;
  };
  const rest = (t: number) => {
    const at = cursorAt!;
    sc.at(t, "cursor", { x: at[0] + 40, y: at[1] + 120, o: 0 }, 0.6);
    cursorAt = null;
  };
  const open = (t: number, app: string, r: Rect, dur = 0.8) => {
    sc.at(t, app, { o: 1 }, 0.2).at(
      t,
      app,
      { x: r.x, y: r.y, w: r.w, h: r.h },
      dur,
    );
  };
  const close = (t: number, app: string, r: Rect, dur = 0.6) => {
    sc.at(t, app, { x: r.x, y: r.y, w: r.w, h: r.h }, dur).at(
      t + dur * 0.5,
      app,
      { o: 0 },
      dur * 0.5,
    );
  };
  const swap = (t: number, from: string, to: string) => {
    close(t, from, dot(mid(slot)), 0.4);
    open(t + 0.15, to, slot, 0.7);
  };
  const fade = (t: number, part: string, o: number, dur = 0.4) => {
    sc.at(t, part, { o }, dur);
  };
  const cover = (t: number, parts: string[]) => {
    for (const n of parts) sc.at(t, n, { o: 0 }, 0);
  };
  let t: number;

  // natural: a place link is typed; the place unfurls inside the page and pushes the rest down
  sc.at(0.15, "type", { p: 1 }, 0.9, "out");
  fade(1.0, "pchip", 1, 0.3);
  sc.at(1.35, "map", { h: M.h, o: 1 }, 0.9).at(1.35, "below", { y: PUSH }, 0.9);
  // a click: the helper conversation floats over the page (the one guest that overlays its host)
  t = click(3.6, P_CHAT);
  sc.at(t, "conv", { x: chatR.x, o: 1 }, 0.6, "out");
  // a click: the conversation grows into the agent manager, its list of conversations coming in beside it
  t = click(5.3, P_EXP);
  sc.at(t, "conv", { x: full.x, y: full.y, w: full.w, h: full.h }, 1.0).at(
    t,
    "talk",
    { x: CONV.agent[0], y: CONV.agent[1] },
    1.0,
  );
  fade(t, "chead", 0, 0.3);
  fade(t + 0.4, "alist", 1, 0.6);
  cover(t + 1.0, ["page"]);
  rest(t + 1.0);
  // you ask; the agent answers with a prototype — a click opens it in the side column
  fade(6.9, "ask", 1, 0.4);
  fade(7.7, "reply", 1, 0.5);
  t = click(9.2, P_PROTO);
  open(t, "proto", slot);
  // a click on the prototype's folder: the explorer takes the conversation's place, the prototype stays
  t = click(10.9, P_FOLD);
  open(t, "expl", full, 0.9);
  cover(t + 0.9, ["conv"]);
  // clicks on files: each opens in the side column — a video, a song in its piano roll, a page
  t = click(12.8, tile("video"));
  swap(t, "proto", "video");
  t = click(14.5, tile("note"));
  swap(t, "video", "son");
  t = click(17.4, tile("page"));
  swap(t, "son", "page2");
  // a click: the page preview expands into the page — where the cycle began
  t = click(19.1, P_PEXP);
  sc.at(t, "page2", { x: full.x, y: full.y, w: full.w, h: full.h }, 1.0).at(
    t,
    "pmain",
    { x: 0, y: 0 },
    1.0,
  );
  fade(t, "pexp", 0, 0.3);
  fade(t + 0.3, "pside", 1, 0.6);
  cover(t + 1.0, ["expl"]);
  rest(t + 1.0);
  // under that page, everything goes back to the start, unseen, so the loop's wrap is invisible
  const reset: [string, Record<string, number>][] = [
    ["page", { o: 1 }],
    ["type", { p: 0 }],
    ["pchip", { o: 0 }],
    ["below", { y: 0 }],
    ["map", { h: 0, o: 0 }],
    ["conv", { x: chatR.x + 40, y: chatR.y, w: CW, h: CH, o: 0 }],
    ["chead", { o: 1 }],
    ["alist", { o: 0 }],
    ["talk", { x: CONV.chat[0], y: CONV.chat[1] }],
    ["ask", { o: 0 }],
    ["reply", { o: 0 }],
    ["expl", withO(dot(P_FOLD), 0)],
    ["proto", withO(dot(P_PROTO), 0)],
    ["video", withO(dot(tile("video")), 0)],
    ["son", withO(dot(tile("note")), 0)],
  ];
  for (const [n, to] of reset) sc.at(21.4, n, to, 0);
  return { back: disc(`${prefix}g2`), front: b, timeline: sc };
}
